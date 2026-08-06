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
