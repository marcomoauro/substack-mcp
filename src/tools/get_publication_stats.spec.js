import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getPublicationStatsHandler, getPublicationStatsSchema} from './get_publication_stats.js';
import {
  createMswServer,
  DASHBOARD_SUMMARY_URL,
  OPEN_RATE_URL,
  VIEWS_30D_URL,
} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';
import {captureLogs} from '../../test/helpers/capture-logs.js';

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

const paths = () => msw.requests.map((request) => new URL(request.url).pathname).sort();

describe('getPublicationStatsSchema', () => {
  test('takes no arguments', () => {
    assert.deepEqual(getPublicationStatsSchema.parse({}), {});
  });

  test('rejects an unknown key by name rather than ignoring it', () => {
    assert.throws(
      () => getPublicationStatsSchema.parse({period: '30d'}),
      (error) => /Unrecognized key/.test(error.message) && /period/.test(error.message)
    );
  });

  test('publishes an object schema that accepts nothing else', () => {
    const json = z.toJSONSchema(getPublicationStatsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
  });
});

describe('getPublicationStatsHandler', () => {
  test('collects the three dashboard endpoints', async () => {
    await getPublicationStatsHandler({});

    assert.equal(msw.requests.length, 3);
    assert.deepEqual(paths(), [
      '/api/v1/publication/stats/email_stats/30d_open_rate',
      '/api/v1/publication/stats/publication_traffic/30d_views',
      '/api/v1/publish-dashboard/summary',
    ]);
  });

  test('issues them all as GETs', async () => {
    await getPublicationStatsHandler({});

    for (const request of msw.requests) assert.equal(request.method, 'GET');
  });

  test('merges them into one flat result', async () => {
    const result = await getPublicationStatsHandler({});

    assert.equal(result.subscribers, 2025);
    assert.equal(result.subscribers_last_30_days, 77);
    assert.equal(result.arr, 120);
    assert.equal(result.views, 5000);
    assert.equal(result.open_rate_30d, 0.42);
    assert.equal(result.open_rate_30d_change, 0.01);
    assert.equal(result.views_30d, 5000);
    assert.equal(result.views_30d_change, 250);
  });

  // One endpoint failing must not take the whole answer down: the other two carry most of the
  // value, and a tool that returns nothing at all is strictly worse than one that says which
  // part it could not reach.
  test('reports a failing endpoint without losing the ones that answered', async () => {
    msw.server.use(msw.statsHandler(OPEN_RATE_URL, () => new HttpResponse('boom', {status: 500})));

    const result = await getPublicationStatsHandler({});

    assert.equal(result.subscribers, 2025);
    assert.equal(result.open_rate_30d, null);
    assert.match(result.errors.open_rate, /500/);
  });

  test('carries no errors key when everything answered', async () => {
    const result = await getPublicationStatsHandler({});

    assert.equal(result.errors, undefined);
  });

  test('still answers when the summary itself is the one failing', async () => {
    msw.server.use(
      msw.statsHandler(DASHBOARD_SUMMARY_URL, () => new HttpResponse('boom', {status: 503}))
    );

    const result = await getPublicationStatsHandler({});

    assert.equal(result.subscribers, null);
    assert.equal(result.views_30d, 5000);
    assert.match(result.errors.summary, /503/);
  });

  test('records what it fetched and what it could not', async () => {
    msw.server.use(msw.statsHandler(VIEWS_30D_URL, () => new HttpResponse('boom', {status: 500})));

    const lines = await captureLogs(() => getPublicationStatsHandler({}));

    const done = lines.find((entry) => entry.msg === 'get_publication_stats.done');
    assert.ok(done, 'expected a get_publication_stats.done log line');
    assert.deepEqual(done.failed, ['views_30d']);

    const failure = lines.find((entry) => entry.msg === 'get_publication_stats.part.failed');
    assert.ok(failure, 'expected the failing part to be logged on its own');
    assert.equal(failure.part, 'views_30d');
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => getPublicationStatsHandler({}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
