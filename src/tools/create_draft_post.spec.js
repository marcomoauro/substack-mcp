import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {createDraftPostHandler, createDraftPostSchema} from './create_draft_post.js';
import {createMswServer, DRAFTS_URL} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';

const msw = createMswServer();
let restoreEnv;

before(() => {
  restoreEnv = setTestEnv();
  msw.start();
});

afterEach(() => msw.reset());

after(() => {
  msw.stop();
  restoreEnv();
});

const VALID_ARGS = {title: 'Il mio titolo', subtitle: 'Il mio sottotitolo', body: 'Il corpo'};

describe('createDraftPostSchema', () => {
  test('accetta title, subtitle e body come stringhe', () => {
    assert.deepEqual(createDraftPostSchema.parse(VALID_ARGS), VALID_ARGS);
  });

  test('richiede tutti e tre i campi', () => {
    assert.throws(() => createDraftPostSchema.parse({title: 'solo il titolo'}), z.ZodError);
  });
});

describe('createDraftPostHandler — successo', () => {
  test('restituisce OK', async () => {
    assert.equal(await createDraftPostHandler(VALID_ARGS), 'OK');
  });

  test('invia una sola richiesta all\'endpoint drafts', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].url, DRAFTS_URL);
  });

  test('mappa gli argomenti sui campi della bozza', async () => {
    await createDraftPostHandler(VALID_ARGS);

    const {body} = msw.requests[0];
    assert.equal(body.draft_title, 'Il mio titolo');
    assert.equal(body.draft_subtitle, 'Il mio sottotitolo');
    assert.deepEqual(body.draft_bylines, [{id: 12345, is_guest: false}]);
    assert.equal(body.audience, 'everyone');
    assert.equal(body.write_comment_permissions, 'everyone');
    assert.equal(body.section_chosen, true);
    assert.equal(body.draft_section_id, null);
  });

  // Prima del fix al doppio encoding l'handler passava la stringa grezza a setBody, e
  // getDraft le applicava JSON.stringify: draft_body arrivava come '"Il corpo"', che
  // l'editor Substack non sa interpretare come documento. Ora parseBody costruisce il
  // documento prima di setBody, quindi draft_body è la serializzazione di un doc valido.
  test('draft_body arriva come documento ProseMirror serializzato', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.deepEqual(JSON.parse(msw.requests[0].body.draft_body), {
      type: 'doc',
      content: [{type: 'paragraph', content: [{type: 'text', text: 'Il corpo'}]}],
    });
  });

  test('autentica con il token preso dalle env var', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.equal(
      msw.requests[0].headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });

  test('legge le env var a runtime, non all\'import del modulo', async () => {
    const previous = process.env.SUBSTACK_USER_ID;
    process.env.SUBSTACK_USER_ID = '99999';

    try {
      await createDraftPostHandler(VALID_ARGS);
      assert.deepEqual(msw.requests[0].body.draft_bylines, [{id: 99999, is_guest: false}]);
    } finally {
      process.env.SUBSTACK_USER_ID = previous;
    }
  });
});

describe('createDraftPostHandler — conversione del body', () => {
  // parseBody non è esportata, quindi la si esercita attraverso l'handler osservando il
  // draft_body effettivamente inviato.
  async function inviaEDecodifica(body) {
    await createDraftPostHandler({...VALID_ARGS, body});
    return JSON.parse(msw.requests.at(-1).body.draft_body);
  }

  function testiDeiParagrafi(doc) {
    return doc.content.map((paragraph) => paragraph.content[0].text);
  }

  test('il testo semplice diventa un singolo paragrafo', async () => {
    const doc = await inviaEDecodifica('Una riga sola');

    assert.deepEqual(doc, {
      type: 'doc',
      content: [{type: 'paragraph', content: [{type: 'text', text: 'Una riga sola'}]}],
    });
  });

  test('i paragrafi separati da una riga vuota diventano nodi distinti', async () => {
    const doc = await inviaEDecodifica('Primo paragrafo\n\nSecondo paragrafo');

    assert.deepEqual(testiDeiParagrafi(doc), ['Primo paragrafo', 'Secondo paragrafo']);
  });

  // Lo split è su /\n+/, quindi ogni interruzione di riga apre un paragrafo: un testo a
  // capo singolo non resta un paragrafo unico. La descrizione della PR parla di "blank
  // lines", ma il comportamento reale è questo.
  test('anche un a capo singolo apre un nuovo paragrafo', async () => {
    const doc = await inviaEDecodifica('Riga uno\nRiga due');

    assert.deepEqual(testiDeiParagrafi(doc), ['Riga uno', 'Riga due']);
  });

  test('le righe vuote in eccesso non producono paragrafi vuoti', async () => {
    const doc = await inviaEDecodifica('\n\nPrimo\n\n\n\nSecondo\n\n');

    assert.deepEqual(testiDeiParagrafi(doc), ['Primo', 'Secondo']);
  });

  test('un documento ProseMirror in JSON viene passato intatto', async () => {
    const documento = {
      type: 'doc',
      content: [
        {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Titolo'}]},
        {type: 'paragraph', content: [{type: 'text', text: 'Corpo'}]},
      ],
    };

    assert.deepEqual(await inviaEDecodifica(JSON.stringify(documento)), documento);
  });

  test('un JSON valido che non è un documento viene trattato come testo', async () => {
    const doc = await inviaEDecodifica('{"a":1}');

    assert.deepEqual(testiDeiParagrafi(doc), ['{"a":1}']);
  });

  test('un JSON malformato viene trattato come testo', async () => {
    const doc = await inviaEDecodifica('{non valido');

    assert.deepEqual(testiDeiParagrafi(doc), ['{non valido']);
  });

  test('una stringa vuota produce un documento senza contenuto', async () => {
    assert.deepEqual(await inviaEDecodifica(''), {type: 'doc', content: []});
  });
});

describe('createDraftPostHandler — errori', () => {
  test('lancia ZodError sugli argomenti invalidi senza fare richieste', async () => {
    await assert.rejects(
      () => createDraftPostHandler({title: 'solo il titolo'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('rifiuta un body che non è una stringa', async () => {
    await assert.rejects(
      () => createDraftPostHandler({...VALID_ARGS, body: {type: 'doc'}}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propaga gli errori dell\'API Substack', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const error = await createDraftPostHandler(VALID_ARGS).catch((e) => e);

    assert.equal(error.response.status, 500);
  });
});
