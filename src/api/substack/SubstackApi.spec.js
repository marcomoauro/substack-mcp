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

describe('SubstackApi — constructor', () => {
  test('derives publication_url and hostname', () => {
    const api = createApi();

    assert.equal(api.publication_url, 'https://test.substack.com/api/v1');
    assert.equal(api.hostname, 'https://test.substack.com');
  });

  test('base_url defaults to substack.com', () => {
    const api = createApi();

    assert.equal(api.base_url, 'https://substack.com/api/v1');
  });

  test('an explicit base_url wins over the default', () => {
    const api = new SubstackApi({
      publication_url: TEST_ENV.SUBSTACK_PUBLICATION_URL,
      auth_token: 'tok',
      base_url: 'https://custom.example/api/v9',
    });

    assert.equal(api.base_url, 'https://custom.example/api/v9');
  });

  test('builds the cookie with both session names', () => {
    const api = createApi();

    assert.equal(
      api.auth_cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });
});

describe('SubstackApi — postDraft', () => {
  test('sends a POST to the drafts endpoint with the right headers and body', async () => {
    const api = createApi();

    const result = await api.postDraft({draft_title: 'Title', draft_body: '{}'});

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
    assert.match(request.headers['content-type'], /^application\/json/);
    assert.deepEqual(request.body, {draft_title: 'Title', draft_body: '{}'});
  });

  test('returns the response payload', async () => {
    msw.server.use(
      msw.draftsHandler(() => HttpResponse.json({id: 42, custom: true}, {status: 201}))
    );

    const result = await createApi().postDraft({});

    assert.deepEqual(result, {id: 42, custom: true});
  });

  // fetch does not throw on non-2xx, so handleResponse is the one deciding: the
  // SubstackAPIException branch is now the actual error path. Under axios this test
  // asserted an AxiosError carrying `response.status` instead.
  test('throws a SubstackAPIException on 500', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const error = await createApi().postDraft({}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 500\b/);
  });

  test('throws on 401 and still records the request', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('unauthorized', {status: 401})));

    const error = await createApi().postDraft({}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 401\b/);
    assert.equal(msw.requests.length, 1);
  });

  test('throws a SubstackRequestException when a 2xx body is not JSON', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('not json', {status: 200})));

    const error = await createApi().postDraft({}).catch((e) => e);

    assert.match(error.message, /^SubstackRequestException: Invalid Response: not json$/);
  });
});
