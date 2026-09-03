import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import SubstackApi from './SubstackApi.js';
import {
  createMswServer,
  DRAFTS_URL,
  DRAFT_RESPONSE,
  IMAGE_URL,
  IMAGE_UPLOAD_RESPONSE,
  SUBSCRIBER_STATS_URL,
  SUBSCRIBER_STATS_RESPONSE,
  POSTS_RESPONSE,
  DRAFT_DETAIL_RESPONSE,
  DASHBOARD_SUMMARY_RESPONSE,
  SUBSCRIBER_SET_URL,
  SUBSCRIBER_SET_EXPORT_URL,
  SUBSCRIBER_SET_ID,
  EXPORT_ID,
  EXPORT_FILE_PATH,
  EXPORT_FILE_URL,
  EXPORT_CSV,
} from '../../../test/helpers/msw-server.js';
import {TEST_ENV, setTestEnv} from '../../../test/helpers/env.js';
import {captureLogs} from '../../../test/helpers/capture-logs.js';

const msw = createMswServer();
let restoreEnv;

// setTestEnv is here for its SUBSTACK_MCP_LOG_LEVEL=silent: this file reads no env var, but
// every method it exercises logs, and the lines would otherwise land in the reporter output.
before(() => {
  restoreEnv = setTestEnv();
  msw.start();
});
afterEach(() => msw.reset());
after(() => {
  msw.stop();
  restoreEnv();
});

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

describe('SubstackApi — uploadImage', () => {
  test('POSTs the data URI as JSON and returns the parsed body', async () => {
    const api = createApi();

    const result = await api.uploadImage({image: 'data:image/jpeg;base64,QUJD'});

    const seen = msw.requests.find((r) => r.url === IMAGE_URL);
    assert.equal(seen.method, 'POST');
    assert.match(seen.headers['content-type'], /^application\/json/);
    assert.deepEqual(seen.body, {image: 'data:image/jpeg;base64,QUJD'});
    assert.equal(result.url, IMAGE_UPLOAD_RESPONSE.url);
    assert.equal(result.bytes, 82768);
  });

  test('includes postId only when post_id is given', async () => {
    const api = createApi();

    await api.uploadImage({image: 'data:image/png;base64,QQ==', post_id: 42});

    const seen = msw.requests.find((r) => r.url === IMAGE_URL);
    assert.deepEqual(seen.body, {image: 'data:image/png;base64,QQ==', postId: 42});
  });

  test('omits postId when post_id is absent', async () => {
    const api = createApi();

    await api.uploadImage({image: 'data:image/png;base64,QQ=='});

    const seen = msw.requests.find((r) => r.url === IMAGE_URL);
    assert.deepEqual(Object.keys(seen.body), ['image']);
  });
});

describe('SubstackApi — getSubscribers', () => {
  test('POSTs the query to the subscriber-stats endpoint', async () => {
    const query = {filters: {subscription_type: 'free'}, limit: 25, offset: 0};

    const result = await createApi().getSubscribers(query);

    assert.deepEqual(result, SUBSCRIBER_STATS_RESPONSE);
    assert.equal(msw.requests.length, 1);

    const [request] = msw.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SUBSCRIBER_STATS_URL);
    assert.deepEqual(request.body, query);
  });

  test('authenticates with the session cookie', async () => {
    await createApi().getSubscribers({filters: {}, limit: 1, offset: 0});

    assert.equal(
      msw.requests[0].headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });

  test('throws a SubstackAPIException when the API rejects the filters', async () => {
    msw.server.use(
      msw.subscriberStatsHandler(() => new HttpResponse('bad filter', {status: 400}))
    );

    const error = await createApi().getSubscribers({filters: {}}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });
});

describe('SubstackApi — getPosts', () => {
  test('GETs the requested status with pagination and sort in the query string', async () => {
    const result = await createApi().getPosts({
      status: 'published',
      limit: 25,
      offset: 50,
      order_by: 'post_date',
      order_direction: 'desc',
    });

    assert.deepEqual(result, POSTS_RESPONSE);

    const url = new URL(msw.requests[0].url);
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(url.pathname, '/api/v1/post_management/published');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.equal(url.searchParams.get('offset'), '50');
    assert.equal(url.searchParams.get('order_by'), 'post_date');
    assert.equal(url.searchParams.get('order_direction'), 'desc');
  });

  test('includes the search term as `query` when one is given', async () => {
    await createApi().getPosts({
      status: 'drafts',
      limit: 25,
      offset: 0,
      order_by: 'draft_updated_at',
      order_direction: 'desc',
      query: 'mcp',
    });

    assert.equal(new URL(msw.requests[0].url).searchParams.get('query'), 'mcp');
  });

  // An empty `query=` is what the dashboard sends, but a null one must not become the string
  // "null" in the URL — that would search for a post named null and return nothing.
  test('omits `query` entirely when no search term is given', async () => {
    await createApi().getPosts({
      status: 'drafts',
      limit: 25,
      offset: 0,
      order_by: 'draft_updated_at',
      order_direction: 'desc',
    });

    assert.equal(new URL(msw.requests[0].url).searchParams.has('query'), false);
  });
});

describe('SubstackApi — getDraft', () => {
  test('GETs the draft by id', async () => {
    const result = await createApi().getDraft(167712345);

    assert.deepEqual(result, DRAFT_DETAIL_RESPONSE);
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(new URL(msw.requests[0].url).pathname, '/api/v1/drafts/167712345');
  });

  test('throws a SubstackAPIException on 404', async () => {
    msw.server.use(msw.draftDetailHandler(() => new HttpResponse('nope', {status: 404})));

    const error = await createApi().getDraft(999).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 404\b/);
  });
});

describe('SubstackApi — request', () => {
  test('performs a bare GET against a publication path', async () => {
    const result = await createApi().request({method: 'GET', path: '/publish-dashboard/summary'});

    assert.deepEqual(result, DASHBOARD_SUMMARY_RESPONSE);
    assert.equal(new URL(msw.requests[0].url).pathname, '/api/v1/publish-dashboard/summary');
  });

  test('sends no body on a GET', async () => {
    await createApi().request({method: 'GET', path: '/publish-dashboard/summary'});

    assert.equal(msw.requests[0].body, '');
  });
});

describe('SubstackApi — subscriber set and export', () => {
  test('createSubscriberSet posts the query and returns the set id', async () => {
    const result = await createApi().createSubscriberSet({activity_rating: 5});

    assert.deepEqual(result, {id: SUBSCRIBER_SET_ID});
    assert.equal(msw.requests[0].method, 'POST');
    assert.equal(msw.requests[0].url, SUBSCRIBER_SET_URL);
    assert.deepEqual(msw.requests[0].body, {query: {activity_rating: 5}});
  });

  test('createSubscriberSet can build a set from explicit user ids instead', async () => {
    await createApi().createSubscriberSet(null, [1, 2, 3]);

    assert.deepEqual(msw.requests[0].body, {user_ids: [1, 2, 3]});
  });

  test('requestSubscriberSetExport posts the set id and the columns', async () => {
    const result = await createApi().requestSubscriberSetExport({
      subscriber_set_id: SUBSCRIBER_SET_ID,
      columns: ['user_email_address', 'num_email_opens'],
    });

    assert.deepEqual(result, {export_id: EXPORT_ID});
    assert.equal(msw.requests[0].url, SUBSCRIBER_SET_EXPORT_URL);
    assert.deepEqual(msw.requests[0].body, {
      subscriberSetId: SUBSCRIBER_SET_ID,
      columns: ['user_email_address', 'num_email_opens'],
    });
  });

  test('getSubscriberSetExport polls the export by id', async () => {
    const result = await createApi().getSubscriberSetExport(EXPORT_ID);

    assert.deepEqual(result, {url: EXPORT_FILE_PATH});
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(new URL(msw.requests[0].url).pathname, `/api/v1/subscriber_set/export/${EXPORT_ID}`);
  });

  // Measured live 2026-09-03: while Substack is still generating the file the poll answers
  // 400 {"error":"Export not ready"} — NOT a 200 with an absent url. It stayed there for ~3s on a
  // 6-row export. Reported as issue #25, where it aborted every single export.
  test('getSubscriberSetExport reports a not-ready export as pending instead of throwing', async () => {
    msw.server.use(msw.exportStatusHandler(() =>
      HttpResponse.json({error: 'Export not ready', type: 'single'}, {status: 400})
    ));

    const result = await createApi().getSubscriberSetExport(EXPORT_ID);

    assert.deepEqual(result, {pending: true});
  });

  // Only that one 400 is a state; every other refusal is still a refusal. Swallowing them all
  // would turn a rejected set id into an export that polls until the wait budget runs out.
  test('getSubscriberSetExport still throws on a 400 that is not the pending state', async () => {
    msw.server.use(msw.exportStatusHandler(() =>
      HttpResponse.json({error: 'Subscriber set not found', type: 'single'}, {status: 400})
    ));

    const error = await createApi().getSubscriberSetExport(EXPORT_ID).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });

  // The thrown message carries only the status, so without these the body Substack sent to explain
  // the refusal is readable in the log and nowhere else — which is what made #25 present as a bare
  // "400 Bad Request" with no hint of which of the four steps failed.
  test('a failing status attaches its status and body to the error', async () => {
    msw.server.use(msw.exportStatusHandler(() =>
      HttpResponse.json({error: 'Export not ready', type: 'single'}, {status: 418})
    ));

    const error = await createApi().getSubscriberSetExport(EXPORT_ID).catch((e) => e);

    assert.equal(error.status, 418);
    assert.match(error.body, /Export not ready/);
  });

  // The export answers with a relative url, so it has to be resolved against the publication host
  // rather than concatenated onto publication_url — which already ends in /api/v1 and would produce
  // /api/v1/api/v1/...
  test('downloadExport resolves the relative url against the publication host', async () => {
    const csv = await createApi().downloadExport(EXPORT_FILE_PATH);

    assert.equal(csv, EXPORT_CSV);
    assert.equal(msw.requests[0].url, EXPORT_FILE_URL);
  });

  test('downloadExport returns the CSV as text rather than trying to parse it as JSON', async () => {
    const csv = await createApi().downloadExport(EXPORT_FILE_PATH);

    assert.equal(typeof csv, 'string');
    assert.match(csv, /^Email,Name,/);
  });

  test('downloadExport sends the session cookie, which the file requires', async () => {
    await createApi().downloadExport(EXPORT_FILE_PATH);

    assert.equal(
      msw.requests[0].headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });

  test('downloadExport accepts an absolute url too', async () => {
    await createApi().downloadExport(EXPORT_FILE_URL);

    assert.equal(msw.requests[0].url, EXPORT_FILE_URL);
  });

  // A raw-text request must still refuse a failing status: silently returning an error page as if it
  // were the CSV would have the parser produce nonsense rows instead of an error.
  test('a failing status on a text request still throws SubstackAPIException', async () => {
    msw.server.use(msw.exportFileHandler(() => new HttpResponse('nope', {status: 403})));

    const error = await createApi().downloadExport(EXPORT_FILE_PATH).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 403\b/);
  });
});

describe('SubstackApi — logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  // `has_auth_token` matches the redaction pattern twice over (`auth`, `token`) and used to be
  // logged as `***`, which said only that the field existed. Booleans are now exempt.
  test('the constructor reports whether a token arrived, without logging it', async () => {
    const lines = await captureLogs(() => createApi());

    const created = find(lines, 'substack_api.created');
    assert.equal(created.has_auth_token, true);
    assert.equal(created.publication_url, 'https://test.substack.com/api/v1');
    assert.doesNotMatch(JSON.stringify(created), new RegExp(TEST_ENV.SUBSTACK_SESSION_TOKEN));
  });

  test('a successful response is logged with its parsed body', async () => {
    const lines = await captureLogs(() => createApi().postDraft({draft_title: 'Title'}));

    const body = find(lines, 'substack.response.body');
    assert.equal(body.status, 200);
    assert.deepEqual(body.body, DRAFT_RESPONSE);
  });

  test('a 2xx body that is not JSON is logged before the exception', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('not json', {status: 200})));

    const lines = await captureLogs(() => createApi().postDraft({}).catch(() => {}));

    const invalid = find(lines, 'substack.response.invalid');
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body, 'not json');
  });
});
// `substack.request.failed` is covered in src/index.spec.js instead: a fetch to a closed port
// here would be flagged by MSW as an unhandled request, since it intercepts the whole process.
