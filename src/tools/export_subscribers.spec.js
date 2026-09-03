import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {
  exportSubscribersHandler,
  exportSubscribersSchema,
  EXPORT_POLL_BACKOFF_SECONDS,
} from './export_subscribers.js';
import {
  createMswServer,
  SUBSCRIBER_SET_URL,
  SUBSCRIBER_SET_EXPORT_URL,
  SUBSCRIBER_SET_ID,
  EXPORT_ID,
  EXPORT_FILE_PATH,
} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';
import {captureLogs} from '../../test/helpers/capture-logs.js';
import {SUBSCRIBER_COLUMN_NAMES} from '../api/substack/SubscriberQuery.js';

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

// The real backoff sleeps for seconds at a time. Tests inject a no-op that records what it was
// asked to wait, so the polling behaviour is asserted without the suite paying for it.
function fakeClock() {
  const slept = [];
  return {slept, sleep: async (seconds) => { slept.push(seconds); }};
}

const run = (args = {}, clock = fakeClock()) => exportSubscribersHandler(args, clock);

describe('exportSubscribersSchema', () => {
  test('accepts an empty call', () => {
    assert.deepEqual(exportSubscribersSchema.parse({}), {});
  });

  test('accepts filters, search, columns and a wait budget', () => {
    const args = {
      filters: [{column: 'activity_rating', operator: 'is', value: 5}],
      search: 'gmail',
      columns: ['user_email_address', 'num_email_opens'],
      max_wait_seconds: 60,
    };

    assert.deepEqual(exportSubscribersSchema.parse(args), args);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => exportSubscribersSchema.parse({cols: []}),
      (error) => /Unrecognized key/.test(error.message) && /cols/.test(error.message)
    );
  });

  test('rejects a column that does not exist', () => {
    assert.throws(() => exportSubscribersSchema.parse({columns: ['email']}), z.ZodError);
  });

  test('bounds the wait budget', () => {
    assert.throws(() => exportSubscribersSchema.parse({max_wait_seconds: 0}), z.ZodError);
    assert.throws(() => exportSubscribersSchema.parse({max_wait_seconds: 601}), z.ZodError);
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(exportSubscribersSchema, {target: 'draft-7', io: 'input'});

    for (const field of ['filters', 'search', 'columns', 'max_wait_seconds']) {
      assert.ok(json.properties[field].description, `${field} has no description`);
    }

    assert.equal(json.additionalProperties, false);
  });
});

describe('exportSubscribersHandler — the four-step flow', () => {
  test('creates a set, asks for the export, polls it and downloads the file', async () => {
    await run();

    const paths = msw.requests.map((request) => new URL(request.url).pathname);
    assert.deepEqual(paths, [
      '/api/v1/subscriber_set',
      '/api/v1/subscriber_set/export',
      `/api/v1/subscriber_set/export/${EXPORT_ID}`,
      EXPORT_FILE_PATH,
    ]);
  });

  test('sends the translated filters as the set query', async () => {
    await run({filters: [{column: 'activity_rating', operator: 'is', value: 5}]});

    assert.equal(msw.requests[0].url, SUBSCRIBER_SET_URL);
    assert.deepEqual(msw.requests[0].body, {query: {activity_rating: 5}});
  });

  // The same translation as list_subscribers, so `contains` on a String column has to arrive as
  // the _similar_to suffix rather than the raw operator name.
  test('reuses the subscriber filter translation, suffixes included', async () => {
    await run({filters: [{column: 'user_email_address', operator: 'contains', value: 'gmail'}]});

    assert.deepEqual(msw.requests[0].body, {query: {user_email_address_similar_to: 'gmail'}});
  });

  test('search travels inside the query, where the API reads it', async () => {
    await run({search: 'gmail'});

    assert.deepEqual(msw.requests[0].body, {query: {search: 'gmail'}});
  });

  // Neither belongs in a set: the export covers the whole matching group, and paging it would
  // silently return a slice of the audience.
  test('sends no limit or offset — an export is the whole set', async () => {
    await run({filters: [{column: 'subscription_type', operator: 'is', value: 'free'}]});

    assert.deepEqual(Object.keys(msw.requests[0].body), ['query']);
    assert.equal(msw.requests[0].body.query.limit, undefined);
    assert.equal(msw.requests[0].body.query.offset, undefined);
  });

  test('passes the set id it was given back to the export request', async () => {
    await run();

    assert.equal(msw.requests[1].url, SUBSCRIBER_SET_EXPORT_URL);
    assert.equal(msw.requests[1].body.subscriberSetId, SUBSCRIBER_SET_ID);
  });

  // The whole point of the tool: engagement columns are filterable but not readable through
  // subscriber-stats, and the export is what makes them readable. Defaulting to a subset would
  // quietly give up that capability.
  test('defaults to asking for every column', async () => {
    await run();

    assert.deepEqual(msw.requests[1].body.columns, SUBSCRIBER_COLUMN_NAMES);
  });

  test('an explicit column list is sent as given', async () => {
    await run({columns: ['user_email_address', 'num_comments']});

    assert.deepEqual(msw.requests[1].body.columns, ['user_email_address', 'num_comments']);
  });
});

describe('exportSubscribersHandler — parsing the CSV back', () => {
  test('returns one record per data row', async () => {
    const result = await run();

    assert.equal(result.count, 2);
    assert.equal(result.subscribers.length, 2);
  });

  // The header carries human labels; the records must come back keyed by column name, or the caller
  // cannot correlate them with the filters it just used.
  test('maps the label header back onto column keys', async () => {
    const [first] = (await run()).subscribers;

    assert.equal(first.user_email_address, 'one@example.com');
    assert.equal(first.user_name, 'One');
    assert.equal(first.num_email_opens_last_30d, '2');
    assert.equal(first.num_web_post_views, '1');
    assert.equal(first.activity_rating, '5');
    assert.equal(first.country, 'BR');
  });

  test('does not key anything by the raw label', async () => {
    const [first] = (await run()).subscribers;

    assert.equal(first['Emails opened (30d)'], undefined);
    assert.equal(first['Email'], undefined);
  });

  // A name containing a comma is the case a split(',') gets wrong, shifting every later column of
  // that row by one.
  test('keeps a comma inside a quoted name in one field', async () => {
    const [, second] = (await run()).subscribers;

    assert.equal(second.user_name, 'Two, Junior');
    assert.equal(second.country, 'IT');
  });

  test('reports the columns it actually got back', async () => {
    const result = await run();

    assert.deepEqual(result.columns, [
      'user_email_address', 'user_name', 'subscription_created_at',
      'num_email_opens_last_30d', 'num_web_post_views', 'total_revenue_generated',
      'activity_rating', 'country', 'group_membership',
    ]);
  });

  // Measured against the live API 2026-09-03: asking for all 48 returns 47, and the only column
  // that never comes back is `tag_ids`. It is dropped with no error at all, so a caller told only
  // "success" would believe it had the tags. `group_membership` exports fine — this test and the
  // CSV fixture both used to claim otherwise.
  test('names the requested columns that never came back', async () => {
    const result = await run({columns: ['user_email_address', 'tag_ids', 'group_membership']});

    assert.deepEqual(result.missing_columns, ['tag_ids']);
  });

  test('missing_columns is empty when everything asked for arrived', async () => {
    const result = await run({columns: ['user_email_address', 'user_name']});

    assert.deepEqual(result.missing_columns, []);
  });

  test('an export with only a header yields no records and no error', async () => {
    msw.server.use(msw.exportFileHandler(() => new HttpResponse('Email,Name', {status: 200})));

    const result = await run();

    assert.equal(result.count, 0);
    assert.deepEqual(result.subscribers, []);
  });

  // Values arrive display-formatted, not raw: the same field is the number 50 through
  // subscriber-stats and the string "€50.00" here. Pinning it so the difference stays visible.
  test('leaves values as the export formatted them', async () => {
    const [, second] = (await run()).subscribers;

    assert.equal(second.total_revenue_generated, '€50.00');
    assert.equal(second.subscription_created_at, '2026-06-01T10:00:00.000Z');
  });

  test('an unrecognised header is kept under its raw label rather than dropped', async () => {
    msw.server.use(msw.exportFileHandler(() => new HttpResponse('Email,Brand New Column\na@b.c,42', {status: 200})));

    const result = await run();

    assert.equal(result.subscribers[0]['Brand New Column'], '42');
    assert.deepEqual(result.unmapped_columns, ['Brand New Column']);
  });
});

describe('exportSubscribersHandler — polling', () => {
  test('polls once and does not sleep when the file is ready immediately', async () => {
    const clock = fakeClock();
    await run({}, clock);

    assert.deepEqual(clock.slept, []);
  });

  test('waits and retries while the export has no url yet', async () => {
    msw.server.use(msw.exportStatusHandler((exportId, attempt) =>
      HttpResponse.json(attempt < 3 ? {} : {url: EXPORT_FILE_PATH}, {status: 200})
    ));

    const clock = fakeClock();
    const result = await run({}, clock);

    assert.equal(result.count, 2);
    assert.deepEqual(clock.slept, [EXPORT_POLL_BACKOFF_SECONDS[0], EXPORT_POLL_BACKOFF_SECONDS[1]]);
  });

  // Issue #25: the live pending state is a 400, and the first poll is immediate, so every export
  // hit it and aborted before the file was ever ready. Verified against the real API on
  // 2026-09-03: ~3s of 400 {"error":"Export not ready"}, then 200 {url}.
  test('keeps polling through the 400 the live API answers while the file is generating', async () => {
    msw.server.use(msw.exportStatusHandler((exportId, attempt) =>
      attempt < 3
        ? HttpResponse.json({error: 'Export not ready', type: 'single'}, {status: 400})
        : HttpResponse.json({url: EXPORT_FILE_PATH}, {status: 200})
    ));

    const clock = fakeClock();
    const result = await run({}, clock);

    assert.equal(result.count, 2);
    assert.deepEqual(clock.slept, [EXPORT_POLL_BACKOFF_SECONDS[0], EXPORT_POLL_BACKOFF_SECONDS[1]]);
  });

  // A 400 that is not the pending state means the export will never arrive, so polling it to the
  // end of the wait budget would replace a clear refusal with a slow timeout.
  test('aborts on a 400 that is not the pending state', async () => {
    msw.server.use(msw.exportStatusHandler(() =>
      HttpResponse.json({error: 'Subscriber set not found', type: 'single'}, {status: 400})
    ));

    const error = await run({}, fakeClock()).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });

  test('follows the documented backoff rather than a fixed interval', async () => {
    assert.deepEqual(EXPORT_POLL_BACKOFF_SECONDS.slice(0, 4), [1, 5, 10, 30]);
    assert.equal(EXPORT_POLL_BACKOFF_SECONDS.at(-1), 60);
  });

  // Better than hanging: the caller is told the export exists and can be retried, instead of the
  // tool call blocking for the full backoff.
  test('gives up at the wait budget and names the export it abandoned', async () => {
    msw.server.use(msw.exportStatusHandler(() => HttpResponse.json({}, {status: 200})));

    const error = await run({max_wait_seconds: 20}, fakeClock()).catch((e) => e);

    assert.match(error.message, /not ready/i);
    assert.match(error.message, new RegExp(EXPORT_ID));
    assert.match(error.message, /max_wait_seconds/);
  });

  test('never sleeps past the wait budget', async () => {
    msw.server.use(msw.exportStatusHandler(() => HttpResponse.json({}, {status: 200})));

    const clock = fakeClock();
    await run({max_wait_seconds: 20}, clock).catch(() => {});

    assert.ok(
      clock.slept.reduce((total, seconds) => total + seconds, 0) <= 20,
      `slept ${clock.slept.join('+')} which exceeds the 20s budget`
    );
  });
});

describe('exportSubscribersHandler — errors', () => {
  test('refuses an illegal filter before creating anything', async () => {
    const error = await run({
      filters: [{column: 'user_email_address', operator: 'gt', value: 1}],
    }).catch((e) => e);

    assert.match(error.message, /does not apply/i);
    assert.equal(msw.requests.length, 0);
  });

  test('throws ZodError on a malformed call without issuing any request', async () => {
    await assert.rejects(
      () => run({max_wait_seconds: 'lots'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates a failure creating the set', async () => {
    msw.server.use(msw.subscriberSetHandler(() => new HttpResponse('nope', {status: 400})));

    const error = await run().catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
    assert.equal(msw.requests.length, 1);
  });

  test('propagates a failure requesting the export', async () => {
    msw.server.use(msw.exportRequestHandler(() => new HttpResponse('nope', {status: 500})));

    const error = await run().catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 500\b/);
  });

  test('propagates a failure downloading the file', async () => {
    msw.server.use(msw.exportFileHandler(() => new HttpResponse('forbidden', {status: 403})));

    const error = await run().catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 403\b/);
  });
});

describe('exportSubscribersHandler — logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('records the arguments it received', async () => {
    const args = {columns: ['user_email_address']};
    const lines = await captureLogs(() => run(args));

    assert.deepEqual(find(lines, 'export_subscribers.start').args, args);
  });

  // Each step is a separate request against a private API; without these, a stalled export is
  // indistinguishable from a stalled download.
  test('records each step of the flow', async () => {
    const lines = await captureLogs(() => run());

    assert.equal(find(lines, 'export_subscribers.set.created').subscriber_set_id, SUBSCRIBER_SET_ID);
    assert.equal(find(lines, 'export_subscribers.export.requested').export_id, EXPORT_ID);
    assert.ok(find(lines, 'export_subscribers.export.ready'));

    const done = find(lines, 'export_subscribers.done');
    assert.equal(done.count, 2);
    // The nine headers EXPORT_CSV carries, not the number requested.
    assert.equal(done.columns, 9);
  });

  test('records each poll that found the export unfinished', async () => {
    msw.server.use(msw.exportStatusHandler((exportId, attempt) =>
      HttpResponse.json(attempt < 2 ? {} : {url: EXPORT_FILE_PATH}, {status: 200})
    ));

    const lines = await captureLogs(() => run({}, fakeClock()));

    const pending = find(lines, 'export_subscribers.export.pending');
    assert.equal(typeof pending.waited_seconds, 'number');
  });

  // Silently dropped columns are the failure mode most likely to mislead, so they get a line of
  // their own at warn rather than only appearing in the result.
  test('warns about columns the export dropped', async () => {
    const lines = await captureLogs(() => run({columns: ['user_email_address', 'tag_ids']}));

    assert.deepEqual(find(lines, 'export_subscribers.columns.missing').missing_columns, ['tag_ids']);
  });

  test('never writes the session token to the log', async () => {
    const lines = await captureLogs(() => run());

    assert.doesNotMatch(JSON.stringify(lines), /test-session-token/);
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => run(), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
