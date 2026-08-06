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

  // CARATTERIZZAZIONE — l'handler passa una stringa a setBody, quindi getDraft applica
  // JSON.stringify a una stringa: draft_body arriva a Substack doppiamente serializzato.
  test('draft_body arriva doppiamente serializzato', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.equal(msw.requests[0].body.draft_body, '"Il corpo"');
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
