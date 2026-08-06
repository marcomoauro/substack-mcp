# Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dotare `substack-mcp` di una suite di unit e integration test con il test runner nativo di Node, in cui ogni chiamata HTTP in uscita è intercettata e mockata, così da bloccare le regressioni nel tempo.

**Architecture:** I test sono colocati accanto ai sorgenti come `<nome>.spec.js`. Le chiamate HTTP verso Substack sono intercettate da MSW configurato con `onUnhandledRequest: 'error'`, che fa fallire il test su qualsiasi richiesta non mockata. Il layer MCP viene reso testabile estraendo `createServer()` in `src/server.js`, e viene esercitato tramite un `Client` reale dell'SDK collegato con `InMemoryTransport`. I file `.spec.js` sono esclusi dal tarball npm e dall'immagine Docker.

**Tech Stack:** Node 22 (`node:test`, `node:assert/strict`), ESM, MSW 2.15.0, `@modelcontextprotocol/sdk` 1.11.2, Zod 3.24.4.

**Spec di riferimento:** `docs/superpowers/specs/2026-08-06-test-suite-design.md`

---

## Note per chi implementa

**I test sono di caratterizzazione.** Bloccano il comportamento *attuale*, non quello
desiderato. Il piano contiene test che documentano esplicitamente delle anomalie (sono
etichettati "comportamento corrente"). **Non correggere il codice di produzione per farle
sparire.** Se un test di caratterizzazione fallisce, il bug è nel test, non nel sorgente.

**Fatti verificati empiricamente** durante la stesura del piano, di cui fidarsi:

1. `node --test` **non** scopre i file `.spec.js` con i pattern di default. Serve il glob
   esplicito `'src/**/*.spec.js'`, tra virgolette singole perché lo espanda Node e non la shell.
2. Gli errori del server MCP arrivano al client come `McpError` con messaggio prefissato
   `MCP error -32603: `. Le asserzioni sui messaggi usano quindi `assert.match`, mai
   `assert.equal`.
3. `client.callTool()` restituisce `{content: [{type: 'text', text: '"OK"'}]}` — le virgolette
   fanno parte della stringa, perché il server applica `JSON.stringify` al valore di ritorno
   dell'handler.
4. MSW intercetta axios e cattura gli header `Cookie` e `referer`; `server.use()` sovrascrive
   l'handler per singolo test; una risposta 500 fa lanciare axios con `err.response.status === 500`.
5. `"files": ["src", "!src/**/*.spec.js"]` esclude davvero gli spec dal tarball npm
   (confermato con `npm pack --dry-run`).

---

## File Structure

| File | Responsabilità |
|---|---|
| `test/helpers/env.js` | Env var di test + funzione di ripristino. Nessuna logica di rete. |
| `test/helpers/msw-server.js` | Server MSW, handler di default per `/drafts`, registrazione delle richieste intercettate. |
| `test/helpers/mcp-harness.js` | Collega un `Client` MCP reale a `createServer()` via `InMemoryTransport`. |
| `src/server.js` | **Nuovo.** `createServer()`: costruisce il `Server` MCP e registra gli handler. Nessun side-effect all'import. |
| `src/index.js` | **Modificato.** Solo entrypoint: check env, `createServer()`, connessione stdio. |
| `src/api/substack/SubstackPost.spec.js` | Unit test del builder. Nessuna rete. |
| `src/api/substack/SubstackApi.spec.js` | Integration test del client HTTP contro MSW. |
| `src/tools/create_draft_post.spec.js` | Integration test dell'handler del tool contro MSW. |
| `src/server.spec.js` | Integration test del protocollo MCP end-to-end. |
| `.dockerignore` | **Nuovo.** Esclude test, `node_modules`, `.git`, `docs` dal contesto di build. |
| `.github/workflows/test.yml` | **Nuovo.** Esegue la suite su push e pull request. |

Percorsi relativi verso gli helper, da tenere a mente:

- da `src/` → `../test/helpers/`
- da `src/tools/` → `../../test/helpers/`
- da `src/api/substack/` → `../../../test/helpers/`

---

## Task 1: Infrastruttura di test

**Files:**
- Modify: `package.json`
- Create: `.dockerignore`

- [ ] **Step 1: Installare MSW come dipendenza di sviluppo**

```bash
yarn add --dev --exact msw@2.15.0
```

- [ ] **Step 2: Verificare che sia finita nelle devDependencies**

Run: `node -e "const p=require('./package.json'); console.log(p.devDependencies)"`
Expected: `{ msw: '2.15.0' }`

- [ ] **Step 3: Aggiungere gli script di test e il campo `files` a `package.json`**

Aggiungere le tre voci in `scripts` accanto a `start`:

```json
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test 'src/**/*.spec.js'",
    "test:watch": "node --test --watch 'src/**/*.spec.js'",
    "test:coverage": "node --test --experimental-test-coverage --test-coverage-exclude='**/*.spec.js' --test-coverage-exclude='test/**' 'src/**/*.spec.js'"
  },
```

E aggiungere il campo `files` subito dopo `bin`:

```json
  "files": [
    "src",
    "!src/**/*.spec.js"
  ],
```

- [ ] **Step 4: Verificare che `npm test` giri (senza spec, deve trovare 0 test)**

Run: `npm test`
Expected: esce con successo, output `# tests 0` / `# fail 0`.

- [ ] **Step 5: Creare `.dockerignore`**

```
node_modules
**/*.spec.js
test
docs
.git
.github
.idea
.vscode
.env*
tmp
coverage
```

- [ ] **Step 6: Verificare l'esclusione dal tarball npm**

Run: `npm pack --dry-run 2>&1 | grep -c 'spec.js'`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git add package.json yarn.lock .dockerignore
git commit -m "chore: add test scripts, msw dev dependency and packaging excludes"
```

---

## Task 2: Helper `env.js`

**Files:**
- Create: `test/helpers/env.js`

- [ ] **Step 1: Scrivere l'helper**

```js
export const TEST_ENV = {
  SUBSTACK_PUBLICATION_URL: 'https://test.substack.com',
  SUBSTACK_SESSION_TOKEN: 'test-session-token',
  SUBSTACK_USER_ID: '12345',
};

/**
 * Imposta le env var di test e restituisce una funzione che ripristina i valori precedenti,
 * così un file di test non altera l'ambiente visto dagli altri.
 */
export function setTestEnv(overrides = {}) {
  const values = {...TEST_ENV, ...overrides};
  const saved = {};

  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    process.env[key] = values[key];
  }

  return function restoreEnv() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
```

- [ ] **Step 2: Verificare che il modulo si importi e faccia round-trip**

Run:
```bash
node -e "
import('./test/helpers/env.js').then(({setTestEnv}) => {
  process.env.SUBSTACK_USER_ID = 'original';
  const restore = setTestEnv();
  console.assert(process.env.SUBSTACK_USER_ID === '12345', 'set failed');
  restore();
  console.assert(process.env.SUBSTACK_USER_ID === 'original', 'restore failed');
  console.log('env helper OK');
});
"
```
Expected: `env helper OK`

- [ ] **Step 3: Commit**

```bash
git add test/helpers/env.js
git commit -m "test: add env var helper"
```

---

## Task 3: Helper `msw-server.js`

**Files:**
- Create: `test/helpers/msw-server.js`

Ogni richiesta viene registrata dentro l'handler stesso, non tramite gli eventi di MSW: così
anche gli override creati con `server.use()` finiscono nel registro, purché costruiti con
`draftsHandler()`.

- [ ] **Step 1: Scrivere l'helper**

```js
import {setupServer} from 'msw/node';
import {http, HttpResponse} from 'msw';
import {TEST_ENV} from './env.js';

export const DRAFTS_URL = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}/api/v1/drafts`;

export const DRAFT_RESPONSE = {
  id: 167712345,
  draft_title: 'Test title',
  draft_subtitle: 'Test subtitle',
  is_published: false,
};

/**
 * Crea il server MSW usato dagli integration test.
 *
 * `requests` accumula ogni richiesta intercettata: {method, url, headers, body}.
 * `draftsHandler(responder)` costruisce un handler per POST /drafts che registra la
 * richiesta e poi delega la risposta a `responder`. Usalo anche negli override via
 * `server.use()`, altrimenti quella richiesta non finisce nel registro.
 */
export function createMswServer() {
  const requests = [];

  async function record(request) {
    const raw = await request.clone().text();

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    requests.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    });
  }

  function draftsHandler(responder) {
    return http.post(DRAFTS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  const server = setupServer(
    draftsHandler(() => HttpResponse.json(DRAFT_RESPONSE, {status: 200}))
  );

  return {
    server,
    requests,
    draftsHandler,
    start() {
      server.listen({onUnhandledRequest: 'error'});
    },
    reset() {
      server.resetHandlers();
      requests.length = 0;
    },
    stop() {
      server.close();
    },
  };
}
```

- [ ] **Step 2: Verificare l'helper con uno smoke test temporaneo**

Creare `test/helpers/msw-server.smoke.spec.js` — **file temporaneo, cancellato allo Step 5**.
Va in `test/helpers/`, quindi non è raggiunto dal glob di `npm test`: si esegue a mano.

```js
import {test, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {HttpResponse} from 'msw';
import {createMswServer, DRAFTS_URL, DRAFT_RESPONSE} from './msw-server.js';

const msw = createMswServer();

before(() => msw.start());
afterEach(() => msw.reset());
after(() => msw.stop());

test('intercetta axios e registra la richiesta', async () => {
  const res = await axios.post(DRAFTS_URL, {draft_title: 'Hello'}, {
    headers: {Cookie: 'substack.sid=tok;', referer: 'https://test.substack.com/publish/post'},
  });

  assert.deepEqual(res.data, DRAFT_RESPONSE);
  assert.equal(msw.requests.length, 1);
  assert.equal(msw.requests[0].url, DRAFTS_URL);
  assert.equal(msw.requests[0].headers.cookie, 'substack.sid=tok;');
  assert.deepEqual(msw.requests[0].body, {draft_title: 'Hello'});
});

test('una richiesta non gestita fa fallire la chiamata', async () => {
  await assert.rejects(() => axios.get('https://not-mocked.example.com/leak'));
});

test('server.use con draftsHandler registra comunque la richiesta', async () => {
  msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

  const err = await axios.post(DRAFTS_URL, {}).catch((e) => e);

  assert.equal(err.response.status, 500);
  assert.equal(msw.requests.length, 1);
});
```

- [ ] **Step 3: Eseguire lo smoke test**

Run: `node --test 'test/helpers/msw-server.smoke.spec.js'`
Expected: `# pass 3` / `# fail 0`

- [ ] **Step 4: Cancellare lo smoke test**

```bash
rm test/helpers/msw-server.smoke.spec.js
```

- [ ] **Step 5: Commit**

```bash
git add test/helpers/msw-server.js
git commit -m "test: add msw server helper with request recording"
```

---

## Task 4: Unit test di `SubstackPost` — costruttore e serializzazione

**Files:**
- Create: `src/api/substack/SubstackPost.spec.js`

- [ ] **Step 1: Scrivere i test**

```js
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import SubstackPost from './SubstackPost.js';

describe('SubstackPost — costruttore', () => {
  test('applica i default e converte user_id a intero', () => {
    const post = new SubstackPost({user_id: '12345'});

    assert.equal(post.draft_title, null);
    assert.equal(post.draft_subtitle, null);
    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
    assert.deepEqual(post.draft_bylines, [{id: 12345, is_guest: false}]);
    assert.equal(post.audience, 'everyone');
    assert.equal(post.draft_section_id, null);
    assert.equal(post.section_chosen, true);
  });

  test('accetta titolo e sottotitolo dal costruttore', () => {
    const post = new SubstackPost({user_id: '1', title: 'T', subtitle: 'S'});

    assert.equal(post.draft_title, 'T');
    assert.equal(post.draft_subtitle, 'S');
  });

  test('write_comment_permissions segue audience quando non specificato', () => {
    const post = new SubstackPost({user_id: '1', audience: 'only_paid'});

    assert.equal(post.audience, 'only_paid');
    assert.equal(post.write_comment_permissions, 'only_paid');
  });

  test('write_comment_permissions esplicito vince su audience', () => {
    const post = new SubstackPost({
      user_id: '1',
      audience: 'only_paid',
      write_comment_permissions: 'everyone',
    });

    assert.equal(post.write_comment_permissions, 'everyone');
  });

  test('senza subscriber_set_id non imposta subscriber_set_id né type', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.equal(post.subscriber_set_id, undefined);
    assert.equal(post.type, undefined);
  });

  test('con subscriber_set_id imposta anche type adhoc_email', () => {
    const post = new SubstackPost({user_id: '1', subscriber_set_id: 77});

    assert.equal(post.subscriber_set_id, 77);
    assert.equal(post.type, 'adhoc_email');
  });
});

describe('SubstackPost — setter', () => {
  test('setTitle, setSubtitle e setBody aggiornano lo stato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setTitle('Nuovo titolo');
    post.setSubtitle('Nuovo sottotitolo');
    post.setBody({type: 'doc', content: [{type: 'paragraph'}]});

    assert.equal(post.draft_title, 'Nuovo titolo');
    assert.equal(post.draft_subtitle, 'Nuovo sottotitolo');
    assert.deepEqual(post.draft_body, {type: 'doc', content: [{type: 'paragraph'}]});
  });
});

describe('SubstackPost — getDraft', () => {
  test('serializza draft_body in stringa e conserva le altre proprietà', () => {
    const post = new SubstackPost({user_id: '42', title: 'T', subtitle: 'S'});

    const draft = post.getDraft();

    assert.equal(draft.draft_title, 'T');
    assert.equal(draft.draft_subtitle, 'S');
    assert.deepEqual(draft.draft_bylines, [{id: 42, is_guest: false}]);
    assert.equal(draft.audience, 'everyone');
    assert.equal(typeof draft.draft_body, 'string');
    assert.equal(draft.draft_body, '{"type":"doc","content":[]}');
  });

  test('non muta l\'istanza', () => {
    const post = new SubstackPost({user_id: '1'});

    post.getDraft();

    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
  });

  // CARATTERIZZAZIONE — comportamento corrente, probabile anomalia.
  // createDraftPostHandler passa una stringa a setBody, quindi getDraft applica
  // JSON.stringify a una stringa e draft_body finisce doppiamente serializzato.
  test('setBody con una stringa produce un draft_body doppiamente serializzato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setBody('testo semplice');

    assert.equal(post.getDraft().draft_body, '"testo semplice"');
  });
});
```

- [ ] **Step 2: Eseguire i test**

Run: `npm test`
Expected: `# fail 0`, con 11 test passati. Se il test sul doppio `JSON.stringify` fallisce,
il sorgente è cambiato: **non modificare `SubstackPost.js`**, verificare cos'è successo.

- [ ] **Step 3: Commit**

```bash
git add src/api/substack/SubstackPost.spec.js
git commit -m "test: cover SubstackPost constructor, setters and getDraft"
```

---

## Task 5: Unit test di `SubstackPost` — costruzione del contenuto

**Files:**
- Modify: `src/api/substack/SubstackPost.spec.js`

- [ ] **Step 1: Aggiungere i test in coda al file**

```js
describe('SubstackPost — blocchi di contenuto', () => {
  test('paragraph con testo semplice', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('Ciao');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', text: 'Ciao'}]},
    ]);
  });

  test('paragraph senza argomenti produce un paragrafo vuoto', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph();

    assert.deepEqual(post.draft_body.content, [{type: 'paragraph'}]);
  });

  test('heading imposta attrs.level', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Titolo', level: 2});

    assert.deepEqual(post.draft_body.content, [
      {type: 'heading', content: [{type: 'text', text: 'Titolo'}], attrs: {level: 2}},
    ]);
  });

  test('heading usa level 1 come default', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Titolo'});

    assert.equal(post.draft_body.content[0].attrs.level, 1);
  });

  test('horizontalRule e paywall', () => {
    const post = new SubstackPost({user_id: '1'});

    post.horizontalRule();
    post.paywall();

    assert.deepEqual(post.draft_body.content, [
      {type: 'horizontal_rule'},
      {type: 'paywall'},
    ]);
  });

  test('bulletList costruisce list_item annidati', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bulletList(['uno', 'due']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'uno'}]}]},
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'due'}]}]},
        ],
      },
    ]);
  });

  test('orderedList aggiunge attrs start/order', () => {
    const post = new SubstackPost({user_id: '1'});

    post.orderedList(['uno']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'ordered_list',
        attrs: {start: 1, order: 1},
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'uno'}]}]},
        ],
      },
    ]);
  });

  test('bold e italic producono paragrafi con i mark corrispondenti', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bold('grassetto');
    post.italic('corsivo');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'strong'}], text: 'grassetto'}]},
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'em'}], text: 'corsivo'}]},
    ]);
  });

  test('shareButton, commentButton e customButton', () => {
    const post = new SubstackPost({user_id: '1'});

    post.shareButton();
    post.commentButton();
    post.customButton({url: 'https://example.com', text: 'Vai'});

    assert.deepEqual(post.draft_body.content, [
      {type: 'button', attrs: {url: '%%share_url%%', text: 'Share', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: '%%half_magic_comments_url%%', text: 'Leave a comment', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: 'https://example.com', text: 'Vai', action: null, class: 'button-wrapper'}},
    ]);
  });

  test('removeLastParagraph rimuove l\'ultimo blocco', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('primo');
    post.paragraph('secondo');
    post.removeLastParagraph();

    assert.equal(post.draft_body.content.length, 1);
    assert.deepEqual(post.draft_body.content[0].content, [{type: 'text', text: 'primo'}]);
  });

  test('captionedImage annida un nodo image2 con i default', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'captionedImage', src: 'https://img.example/a.png'});

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'captionedImage',
        content: [
          {
            type: 'image2',
            attrs: {
              src: 'https://img.example/a.png',
              fullscreen: false,
              imageSize: 'normal',
              height: 819,
              width: 1456,
              resizeWidth: 728,
              bytes: null,
              alt: null,
              title: null,
              type: null,
              href: null,
              belowTheFold: false,
              internalRedirect: null,
            },
          },
        ],
      },
    ]);
  });
});

describe('SubstackPost — youtubeVideo', () => {
  const cases = [
    ['URL youtube.com con parametro v', 'https://www.youtube.com/watch?v=0chZFIZLR_0'],
    ['URL breve youtu.be', 'https://youtu.be/0chZFIZLR_0?si=-Gp9e_RKG3g1SdVG'],
    ['ID nudo', '0chZFIZLR_0'],
  ];

  for (const [label, input] of cases) {
    test(`estrae il video id da: ${label}`, () => {
      const post = new SubstackPost({user_id: '1'});

      post.youtubeVideo(input);

      assert.deepEqual(post.draft_body.content, [
        {type: 'youtube2', attrs: {videoId: '0chZFIZLR_0'}},
      ]);
    });
  }
});

describe('SubstackPost — testo con mark', () => {
  test('addComplexText con un array applica i mark per chunk', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'in grassetto', marks: [{type: 'strong'}]},
      {content: ' e normale'},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {type: 'text', text: 'in grassetto', marks: [{type: 'strong'}]},
      {type: 'text', text: ' e normale', marks: []},
    ]);
  });

  test('un mark link produce attrs.href', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'clicca qui', marks: [{type: 'link', href: 'https://example.com'}]},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {
        type: 'text',
        text: 'clicca qui',
        marks: [{type: 'link', attrs: {href: 'https://example.com'}}],
      },
    ]);
  });
});

describe('SubstackPost — setSection', () => {
  test('imposta draft_section_id quando la sezione esiste', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setSection('News', [{name: 'Altro', id: 1}, {name: 'News', id: 7}]);

    assert.equal(post.draft_section_id, 7);
  });

  test('lancia quando la sezione non esiste', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.throws(
      () => post.setSection('Mancante', [{name: 'News', id: 7}]),
      /Section Mancante does not exist/
    );
  });
});

describe('SubstackPost — subscribeWidget', () => {
  test('add con subscribeWidget senza messaggio usa il testo di default', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget'});

    const [node] = post.draft_body.content;
    assert.equal(node.type, 'subscribeWidget');
    assert.deepEqual(node.attrs, {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'});
    assert.equal(node.content[0].type, 'ctaCaption');
    assert.match(node.content[0].content[0].text, /^Thanks for reading this newsletter!/);
    assert.match(node.content[0].content[0].text, /Subscribe for free/);
  });

  test('add con subscribeWidget e messaggio personalizzato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget', message: 'Messaggio mio'});

    assert.equal(post.draft_body.content[0].content[0].content[0].text, 'Messaggio mio');
  });

  // CARATTERIZZAZIONE — comportamento corrente, probabile copia-incolla dal ramo
  // subscribeWidget: add() con type 'bullet_list' applica la caption di iscrizione
  // invece di costruire una lista.
  test('add con bullet_list applica la caption di iscrizione', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'bullet_list', message: 'Messaggio mio'});

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        attrs: {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'},
        content: [{type: 'ctaCaption', content: [{type: 'text', text: 'Messaggio mio'}]}],
      },
    ]);
  });
});
```

- [ ] **Step 2: Eseguire i test**

Run: `npm test`
Expected: `# fail 0`. Il file `SubstackPost.spec.js` ha ora circa 32 test.

- [ ] **Step 3: Commit**

```bash
git add src/api/substack/SubstackPost.spec.js
git commit -m "test: cover SubstackPost content builders, marks and sections"
```

---

## Task 6: Integration test di `SubstackApi`

**Files:**
- Create: `src/api/substack/SubstackApi.spec.js`

- [ ] **Step 1: Scrivere i test**

```js
import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import SubstackApi from './SubstackApi.js';
import {createMswServer, DRAFTS_URL, DRAFT_RESPONSE} from '../../../test/helpers/msw-server.js';
import {TEST_ENV} from '../../../test/helpers/env.js';

const msw = createMswServer();

before(() => msw.start());
afterEach(() => msw.reset());
after(() => msw.stop());

function createApi() {
  return new SubstackApi({
    publication_url: TEST_ENV.SUBSTACK_PUBLICATION_URL,
    auth_token: TEST_ENV.SUBSTACK_SESSION_TOKEN,
  });
}

describe('SubstackApi — costruttore', () => {
  test('deriva publication_url e hostname', () => {
    const api = createApi();

    assert.equal(api.publication_url, 'https://test.substack.com/api/v1');
    assert.equal(api.hostname, 'https://test.substack.com');
  });

  test('base_url ha un default su substack.com', () => {
    const api = createApi();

    assert.equal(api.base_url, 'https://substack.com/api/v1');
  });

  test('base_url esplicito vince sul default', () => {
    const api = new SubstackApi({
      publication_url: TEST_ENV.SUBSTACK_PUBLICATION_URL,
      auth_token: 'tok',
      base_url: 'https://custom.example/api/v9',
    });

    assert.equal(api.base_url, 'https://custom.example/api/v9');
  });

  test('costruisce il cookie con entrambi i nomi di sessione', () => {
    const api = createApi();

    assert.equal(
      api.auth_cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });
});

describe('SubstackApi — postDraft', () => {
  test('invia POST all\'endpoint drafts con header e body corretti', async () => {
    const api = createApi();

    const result = await api.postDraft({draft_title: 'Titolo', draft_body: '{}'});

    assert.deepEqual(result, DRAFT_RESPONSE);
    assert.equal(msw.requests.length, 1);

    const [request] = msw.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, DRAFTS_URL);
    assert.equal(
      request.headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
    assert.equal(request.headers.referer, 'https://test.substack.com/publish/post');
    assert.deepEqual(request.body, {draft_title: 'Titolo', draft_body: '{}'});
  });

  test('restituisce il payload della risposta', async () => {
    msw.server.use(
      msw.draftsHandler(() => HttpResponse.json({id: 42, custom: true}, {status: 201}))
    );

    const result = await createApi().postDraft({});

    assert.deepEqual(result, {id: 42, custom: true});
  });

  // CARATTERIZZAZIONE — axios lancia sulle risposte non-2xx prima che handleResponse
  // possa valutare lo status, quindi il ramo SubstackAPIException è irraggiungibile.
  test('su 500 lancia un AxiosError, non un SubstackAPIException', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const error = await createApi().postDraft({}).catch((e) => e);

    assert.equal(error.name, 'AxiosError');
    assert.equal(error.response.status, 500);
    assert.doesNotMatch(error.message, /SubstackAPIException/);
  });

  test('su 401 lancia e registra comunque la richiesta', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('unauthorized', {status: 401})));

    const error = await createApi().postDraft({}).catch((e) => e);

    assert.equal(error.response.status, 401);
    assert.equal(msw.requests.length, 1);
  });
});
```

- [ ] **Step 2: Eseguire i test**

Run: `npm test`
Expected: `# fail 0`, con gli 8 nuovi test di `SubstackApi` in verde.

- [ ] **Step 3: Commit**

```bash
git add src/api/substack/SubstackApi.spec.js
git commit -m "test: cover SubstackApi request shape and error behaviour"
```

---

## Task 7: Integration test di `createDraftPostHandler`

**Files:**
- Create: `src/tools/create_draft_post.spec.js`

- [ ] **Step 1: Scrivere i test**

```js
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
```

- [ ] **Step 2: Eseguire i test**

Run: `npm test`
Expected: `# fail 0`, con gli 11 nuovi test dell'handler in verde.

- [ ] **Step 3: Commit**

```bash
git add src/tools/create_draft_post.spec.js
git commit -m "test: cover create_draft_post handler end to end"
```

---

## Task 8: Estrarre `createServer()` e testare il layer MCP

Questo task fa TDD sul refactor: prima l'harness e il test che fallisce perché `src/server.js`
non esiste, poi il modulo che lo fa passare, infine la riduzione di `index.js`.

**Files:**
- Create: `test/helpers/mcp-harness.js`
- Create: `src/server.spec.js`
- Create: `src/server.js`
- Modify: `src/index.js`

- [ ] **Step 1: Scrivere l'harness MCP**

```js
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../../src/server.js';

/**
 * Collega un Client MCP reale al server di produzione tramite una coppia di transport
 * in memoria. Restituisce il client e una funzione di chiusura.
 */
export async function connectMcpClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createServer();
  const client = new Client({name: 'substack-mcp-test-client', version: '1.0.0'}, {capabilities: {}});

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    async close() {
      await Promise.all([client.close(), server.close()]);
    },
  };
}
```

- [ ] **Step 2: Scrivere `src/server.spec.js`**

Nota sulle asserzioni: gli errori arrivano al client come `McpError` con messaggio
prefissato `MCP error -32603: `, quindi si usa `assert.match` e non `assert.equal`.

```js
import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import {connectMcpClient} from '../test/helpers/mcp-harness.js';
import {createMswServer, DRAFTS_URL} from '../test/helpers/msw-server.js';
import {setTestEnv} from '../test/helpers/env.js';

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

const VALID_ARGS = {title: 'Titolo', subtitle: 'Sottotitolo', body: 'Corpo'};

describe('MCP server — list_tools', () => {
  test('espone create_draft_post con la sua descrizione', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();

      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'create_draft_post');
      assert.equal(tools[0].description, 'create a draft post on your Substack account.');
    } finally {
      await close();
    }
  });

  test('pubblica un inputSchema con i tre campi obbligatori', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const {inputSchema} = tools[0];

      assert.equal(inputSchema.type, 'object');
      assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['body', 'subtitle', 'title']);
      assert.deepEqual([...inputSchema.required].sort(), ['body', 'subtitle', 'title']);
      assert.equal(inputSchema.properties.title.type, 'string');
    } finally {
      await close();
    }
  });
});

describe('MCP server — call_tool', () => {
  test('esegue il tool e restituisce il risultato serializzato', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.deepEqual(result.content, [{type: 'text', text: '"OK"'}]);
    } finally {
      await close();
    }
  });

  test('la chiamata raggiunge l\'API Substack', async () => {
    const {client, close} = await connectMcpClient();

    try {
      await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.equal(msw.requests.length, 1);
      assert.equal(msw.requests[0].url, DRAFTS_URL);
      assert.equal(msw.requests[0].body.draft_title, 'Titolo');
    } finally {
      await close();
    }
  });

  test('un tool sconosciuto produce un errore', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'tool_inesistente', arguments: {}})
        .catch((e) => e);

      assert.match(error.message, /Unknown tool: tool_inesistente/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('argomenti invalidi producono un errore Invalid input con i dettagli Zod', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'create_draft_post', arguments: {title: 'solo il titolo'}})
        .catch((e) => e);

      assert.match(error.message, /Invalid input:/);
      assert.match(error.message, /"path":\["subtitle"\]/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('un errore dell\'API Substack si propaga al client', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'create_draft_post', arguments: VALID_ARGS})
        .catch((e) => e);

      assert.match(error.message, /500/);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 3: Eseguire i test per verificare che falliscano**

Run: `npm test`
Expected: FAIL — `Cannot find module .../src/server.js`

- [ ] **Step 4: Creare `src/server.js`**

Il registry `tools` sostituisce lo `switch`, così la lista e l'esecuzione restano allineate
per costruzione. La lookup usa `Object.hasOwn` per non risolvere nomi come `constructor`
sulla catena dei prototipi.

```js
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";

export const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
  },
};

export function createServer() {
  const server = new Server({
      name: "Substack MCP",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        logging: {}
      },
    });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.entries(tools).map(([name, {description, schema}]) => ({
        name,
        description,
        inputSchema: zodToJsonSchema(schema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args} = request.params;

    try {
      if (!Object.hasOwn(tools, name)) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const result = await tools[name].handler(args);

      return {
        content: [{type: "text", text: JSON.stringify(result, null, 2)}],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid input: ${JSON.stringify(error.errors)}`);
      }
      throw error;
    }
  });

  return server;
}
```

- [ ] **Step 5: Eseguire i test per verificare che passino**

Run: `npm test`
Expected: `# fail 0`, con gli 8 test di `server.spec.js` in verde.

- [ ] **Step 6: Ridurre `src/index.js` a entrypoint**

Sostituire l'intero contenuto del file con:

```js
#!/usr/bin/env node

import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createServer} from "./server.js";

// check envs
if (!process.env.SUBSTACK_PUBLICATION_URL || !process.env.SUBSTACK_SESSION_TOKEN || !process.env.SUBSTACK_USER_ID) {
  throw new Error("SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set");
}

const server = createServer();

const transport = new StdioServerTransport();
server.connect(transport).catch(() => {
  process.exit(1);
});
```

- [ ] **Step 7: Verificare che il check delle env var funzioni ancora**

Run:
```bash
env -u SUBSTACK_PUBLICATION_URL -u SUBSTACK_SESSION_TOKEN -u SUBSTACK_USER_ID node src/index.js 2>&1 | head -5
```
Expected: l'errore `SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set`

- [ ] **Step 8: Verificare che il server parta davvero con le env var presenti**

Il server resta in ascolto su stdio, quindi lo si avvia e lo si termina dopo un secondo:
nessun output di errore significa che il boot è andato a buon fine.

```bash
SUBSTACK_PUBLICATION_URL=https://test.substack.com \
SUBSTACK_SESSION_TOKEN=tok \
SUBSTACK_USER_ID=1 \
timeout 1 node src/index.js; echo "exit=$?"
```
Expected: nessuno stack trace; `exit=124` (terminato da `timeout`, quindi era vivo).

- [ ] **Step 9: Eseguire l'intera suite**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 10: Commit**

```bash
git add src/server.js src/server.spec.js src/index.js test/helpers/mcp-harness.js
git commit -m "refactor: extract createServer() and cover the MCP layer with tests"
```

---

## Task 9: CI e verifica finale

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Creare il workflow**

Lo stile segue i workflow esistenti del repo: `actions/checkout@v4` e `actions/setup-node@v4`
con `node-version-file: '.nvmrc'`.

```yaml
name: Test

on:
  workflow_dispatch:
  push:
    branches: [ main ]
  pull_request:

jobs:
  test:
    name: Run test suite
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'yarn'

      - name: Install dependencies
        run: yarn install --frozen-lockfile

      - name: Run tests
        run: yarn test
```

- [ ] **Step 2: Verificare che il workflow sia YAML valido**

Run:
```bash
node -e "
const fs = require('fs');
const text = fs.readFileSync('.github/workflows/test.yml', 'utf8');
if (text.includes('\t')) throw new Error('YAML non può contenere tab');
console.log('workflow leggibile,', text.split('\n').length, 'righe');
"
```
Expected: `workflow leggibile, ...`

- [ ] **Step 3: Eseguire il comando esatto che girerà in CI**

Run: `yarn test`
Expected: `# fail 0`

- [ ] **Step 4: Verificare la coverage**

Run: `npm run test:coverage`
Expected: il report elenca `src/api/substack/SubstackPost.js`, `src/api/substack/SubstackApi.js`,
`src/tools/create_draft_post.js` e `src/server.js`, e **non** elenca alcun file `.spec.js`.
Annotare le percentuali per il riepilogo finale.

- [ ] **Step 5: Verificare che i test non finiscano nel pacchetto npm**

Run: `npm pack --dry-run 2>&1 | grep -c 'spec.js'`
Expected: `0`

- [ ] **Step 6: Verificare che i test non finiscano nell'immagine Docker**

Se Docker è disponibile in locale:
```bash
docker build -t substack-mcp-test . && docker run --rm --entrypoint sh substack-mcp-test -c "find /opt/src -name '*.spec.js' | wc -l"
```
Expected: `0`

Se Docker non è disponibile, verificare almeno che `.dockerignore` copra il pattern:
```bash
grep -q '\*\*/\*.spec.js' .dockerignore && echo "pattern presente"
```
Expected: `pattern presente`

- [ ] **Step 7: Verificare che nessun test raggiunga la rete reale**

Il vincolo è imposto da `onUnhandledRequest: 'error'`: una richiesta non mockata fa fallire
il test invece di uscire sulla rete. Come controprova empirica, la durata totale deve restare
nell'ordine del secondo — una chiamata reale a `substack.com` costerebbe latenza visibile o un
timeout.

```bash
npm test 2>&1 | grep -E '^# (duration_ms|pass|fail)'
```
Expected: `# fail 0` e `# duration_ms` sotto i 5000 ms.

Controprova aggiuntiva: introdurre temporaneamente in un qualsiasi `.spec.js` una chiamata a
un host non mockato, verificare che il test **fallisca**, poi rimuoverla.

```js
// da inserire e poi togliere
test('controprova: la rete è chiusa', async () => {
  const axios = (await import('axios')).default;
  await axios.get('https://substack.com/api/v1/whoami');
});
```
Expected: questo test fallisce con un errore di richiesta non gestita. Rimuoverlo dopo la
verifica.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run the test suite on push and pull requests"
```

---

## Verifica di completamento

Al termine di tutti i task devono valere queste condizioni:

- [ ] `npm test` esce con `# fail 0` e 59 test (32 `SubstackPost` + 8 `SubstackApi` +
      11 `create_draft_post` + 8 `server`)
- [ ] `npm run test:coverage` produce un report che non contiene file `.spec.js`
- [ ] `npm pack --dry-run` non contiene file `.spec.js`
- [ ] `.dockerignore` esiste e contiene `**/*.spec.js`
- [ ] `src/index.js` contiene solo il wiring dell'entrypoint
- [ ] `src/server.js` non ha side-effect all'import (non legge env var, non si connette)
- [ ] `git status` è pulito

Riportare all'autore, come esito finale:

1. Le percentuali di coverage per file.
2. Le quattro anomalie elencate nella sezione "Anomalie note" della spec, confermando quali
   sono ora bloccate da un test di caratterizzazione. Restano da valutare come intervento
   separato.
