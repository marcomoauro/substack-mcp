import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getAnalyticsHandler, getAnalyticsSchema, ANALYTICS_REPORTS} from './get_analytics.js';
import {createMswServer, ANALYTICS_RESPONSE} from '../../test/helpers/msw-server.js';
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

// Date defaults are derived from "now", so the clock is injected rather than read: otherwise every
// assertion about a default window would change meaning tomorrow.
const NOW = new Date('2026-08-07T12:00:00.000Z');
const run = (args, now = () => NOW) => getAnalyticsHandler(args, {now});

const sentUrl = () => new URL(msw.requests.at(-1).url);
const param = (name) => sentUrl().searchParams.get(name);

describe('ANALYTICS_REPORTS', () => {
  // Every report here was verified against the live API during reconnaissance. Two endpoints that
  // exist but answer 400 even for Substack's own dashboard — audience_insights/location and
  // visitor_sources — are deliberately absent, and must not be added back without re-checking.
  test('covers the verified reports and nothing else', () => {
    assert.equal(Object.keys(ANALYTICS_REPORTS).length, 17);
  });

  test('excludes the endpoints that are broken upstream', () => {
    const paths = Object.values(ANALYTICS_REPORTS).map((report) => report.path);

    assert.ok(!paths.some((path) => path.endsWith('/audience_insights/location')));
    assert.ok(!paths.some((path) => path.includes('visitor_sources')));
  });

  test('gives every report a path under the publication stats prefix', () => {
    for (const [name, {path}] of Object.entries(ANALYTICS_REPORTS)) {
      assert.match(path, /^\/publication\/stats\//, `${name} has an unexpected path`);
    }
  });

  test('gives every report a one-line description for the tool schema', () => {
    for (const [name, {description}] of Object.entries(ANALYTICS_REPORTS)) {
      assert.equal(typeof description, 'string', `${name} has no description`);
      assert.ok(description.length > 0, `${name} has an empty description`);
    }
  });
});

describe('getAnalyticsSchema', () => {
  test('requires a report', () => {
    assert.throws(() => getAnalyticsSchema.parse({}), z.ZodError);
  });

  test('accepts every report name', () => {
    for (const report of Object.keys(ANALYTICS_REPORTS)) {
      assert.deepEqual(getAnalyticsSchema.parse({report}), {report});
    }
  });

  test('rejects an unknown report', () => {
    assert.throws(() => getAnalyticsSchema.parse({report: 'revenue'}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getAnalyticsSchema.parse({report: 'email_stats', period: 'month'}),
      (error) => /Unrecognized key/.test(error.message) && /period/.test(error.message)
    );
  });

  test('accepts a date window and a limit', () => {
    const args = {report: 'unsubscribes', from_date: '2026-07-01', to_date: '2026-07-31', limit: 20};

    assert.deepEqual(getAnalyticsSchema.parse(args), args);
  });

  test('rejects a date that is not YYYY-MM-DD', () => {
    assert.throws(() => getAnalyticsSchema.parse({report: 'unsubscribes', from_date: '01/07/2026'}), z.ZodError);
    assert.throws(() => getAnalyticsSchema.parse({report: 'unsubscribes', to_date: 'yesterday'}), z.ZodError);
  });

  test('bounds the limit', () => {
    assert.throws(() => getAnalyticsSchema.parse({report: 'audience_overlap', limit: 0}), z.ZodError);
    assert.throws(() => getAnalyticsSchema.parse({report: 'audience_overlap', limit: 101}), z.ZodError);
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getAnalyticsSchema, {target: 'draft-7', io: 'input'});

    for (const field of ['report', 'from_date', 'to_date', 'limit']) {
      assert.ok(json.properties[field].description, `${field} has no description`);
    }

    assert.equal(json.additionalProperties, false);
  });

  // The 17 report names reach the model only through this enum; published as a bare string it would
  // be unusable by a caller that does not already know them.
  test('publishes the report names as an enum', () => {
    const json = z.toJSONSchema(getAnalyticsSchema, {target: 'draft-7', io: 'input'});

    assert.deepEqual(json.properties.report.enum.sort(), Object.keys(ANALYTICS_REPORTS).sort());
  });
});

describe('getAnalyticsHandler — routing', () => {
  test('every report reaches its own endpoint with a GET', async () => {
    for (const [report, {path}] of Object.entries(ANALYTICS_REPORTS)) {
      msw.requests.length = 0;
      await run({report});

      assert.equal(msw.requests.length, 1, `${report} issued ${msw.requests.length} requests`);
      assert.equal(msw.requests[0].method, 'GET', `${report} was not a GET`);
      assert.equal(sentUrl().pathname, `/api/v1${path}`, `${report} hit the wrong path`);
    }
  });

  test('returns the payload under the report name it was asked for', async () => {
    const result = await run({report: 'email_stats'});

    assert.equal(result.report, 'email_stats');
    assert.deepEqual(result.data, ANALYTICS_RESPONSE);
  });
});

describe('getAnalyticsHandler — date windows', () => {
  const DATE_REPORTS = ['unsubscribes', 'unsubscribes_timeseries', 'growth_sources', 'growth_events'];

  test('the reports that take a window default to the last 30 days', async () => {
    for (const report of DATE_REPORTS) {
      msw.requests.length = 0;
      await run({report});

      assert.equal(param('from_date'), '2026-07-08', `${report} from_date`);
      assert.equal(param('to_date'), '2026-08-07', `${report} to_date`);
    }
  });

  test('an explicit window is used as given', async () => {
    await run({report: 'unsubscribes', from_date: '2026-01-01', to_date: '2026-03-31'});

    assert.equal(param('from_date'), '2026-01-01');
    assert.equal(param('to_date'), '2026-03-31');
  });

  test('one half of a window still defaults the other', async () => {
    await run({report: 'unsubscribes', from_date: '2026-01-01'});

    assert.equal(param('from_date'), '2026-01-01');
    assert.equal(param('to_date'), '2026-08-07');
  });

  // A report that takes no window must not receive one: an unexpected parameter is how several of
  // these endpoints answer 400.
  test('a report that takes no window is sent none', async () => {
    await run({report: 'email_stats', from_date: '2026-01-01', to_date: '2026-03-31'});

    assert.equal(sentUrl().searchParams.has('from_date'), false);
    assert.equal(sentUrl().searchParams.has('to_date'), false);
  });

  // Cohort retention needs a much longer window than 30 days to say anything, and its endpoint takes
  // full ISO timestamps rather than plain dates.
  test('retention spans a year and sends ISO timestamps', async () => {
    await run({report: 'retention'});

    assert.equal(param('start'), '2025-08-07T00:00:00.000Z');
    assert.equal(param('end'), '2026-08-07T00:00:00.000Z');
    assert.equal(param('months'), '12');
    assert.equal(param('is_subscribed'), 'false');
  });

  test('retention honours an explicit window, converted to ISO', async () => {
    await run({report: 'retention', from_date: '2025-01-01', to_date: '2025-12-31'});

    assert.equal(param('start'), '2025-01-01T00:00:00.000Z');
    assert.equal(param('end'), '2025-12-31T00:00:00.000Z');
  });
});

describe('getAnalyticsHandler — fixed parameters', () => {
  // Both of these answer 400 without a limit, which is what makes the default load-bearing rather
  // than cosmetic.
  test('the reports that require a limit get a default one', async () => {
    await run({report: 'audience_overlap'});
    assert.equal(param('limit'), '6');

    await run({report: 'subscriber_notes'});
    assert.equal(param('limit'), '8');
  });

  test('an explicit limit overrides the default', async () => {
    await run({report: 'audience_overlap', limit: 25});

    assert.equal(param('limit'), '25');
  });

  test('a report that takes no limit is sent none', async () => {
    await run({report: 'arr_timeseries', limit: 25});

    assert.equal(sentUrl().searchParams.has('limit'), false);
  });

  test('growth_sources carries the sort the dashboard uses', async () => {
    await run({report: 'growth_sources'});

    assert.equal(param('order_by'), 'users');
    assert.equal(param('order_direction'), 'desc');
  });

  test('network_attribution carries its time window and audience', async () => {
    await run({report: 'network_attribution'});

    assert.equal(param('time_window'), '90 days');
    assert.equal(param('is_subscribed'), 'false');
  });

  test('subscribers_timeseries carries its period', async () => {
    await run({report: 'subscribers_timeseries'});

    assert.equal(param('period'), 'month');
  });
});

describe('getAnalyticsHandler — ignored parameters', () => {
  // Silently dropping a parameter the caller believed in is the failure mode this project has hit
  // twice already, with columnView and with the export's dropped columns. Reporting it instead.
  test('names the parameters the chosen report does not accept', async () => {
    const result = await run({report: 'email_stats', from_date: '2026-01-01', limit: 5});

    assert.deepEqual(result.ignored_params.sort(), ['from_date', 'limit']);
  });

  test('ignored_params is empty when everything given was used', async () => {
    const result = await run({report: 'unsubscribes', from_date: '2026-01-01'});

    assert.deepEqual(result.ignored_params, []);
  });

  test('reports the parameters it actually sent', async () => {
    const result = await run({report: 'audience_overlap'});

    assert.deepEqual(result.params, {limit: 6});
  });
});

describe('getAnalyticsHandler — errors and logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('throws ZodError on an unknown report without issuing any request', async () => {
    await assert.rejects(
      () => run({report: 'nope'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates a Substack API error', async () => {
    msw.server.use(msw.analyticsHandler(() => new HttpResponse('bad window', {status: 400})));

    const error = await run({report: 'unsubscribes'}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });

  test('records the arguments and the report it resolved them to', async () => {
    const lines = await captureLogs(() => run({report: 'retention'}));

    assert.deepEqual(find(lines, 'get_analytics.start').args, {report: 'retention'});

    const resolved = find(lines, 'get_analytics.resolved');
    assert.equal(resolved.report, 'retention');
    assert.equal(resolved.path, '/publication/stats/subscriber_retention');
    assert.equal(resolved.params.months, 12);
  });

  test('records how much came back', async () => {
    const lines = await captureLogs(() => run({report: 'email_stats'}));

    assert.equal(find(lines, 'get_analytics.done').report, 'email_stats');
  });

  test('warns about parameters it had to ignore', async () => {
    const lines = await captureLogs(() => run({report: 'email_stats', limit: 5}));

    assert.deepEqual(find(lines, 'get_analytics.params.ignored').ignored_params, ['limit']);
  });

  test('never writes the session token to the log', async () => {
    const lines = await captureLogs(() => run({report: 'email_stats'}));

    assert.doesNotMatch(JSON.stringify(lines), /test-session-token/);
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => run({report: 'email_stats'}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
