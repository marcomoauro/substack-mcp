import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getPostStatsHandler, getPostStatsSchema, POST_STAT_FIELDS} from './get_post_stats.js';
import {createMswServer, EMAIL_STATS_URL, POST_STATS_RESPONSE} from '../../test/helpers/msw-server.js';
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

const sentUrl = () => new URL(msw.requests.at(-1).url);
const param = (name) => sentUrl().searchParams.get(name);

describe('POST_STAT_FIELDS', () => {
  // The 43 fields a real response carries. The count is the guard: this list is what the schema
  // enum is built from, and a field quietly dropped from it becomes a sort the caller cannot ask for.
  test('lists all 43 fields the endpoint returns', () => {
    assert.equal(POST_STAT_FIELDS.length, 43);
  });

  test('has no duplicates', () => {
    assert.equal(new Set(POST_STAT_FIELDS).size, POST_STAT_FIELDS.length);
  });

  test('covers the conversion metrics, which are the point of the tool', () => {
    for (const field of [
      'signups', 'subscribes', 'founding_subscribes', 'annual_subscribes', 'monthly_subscribes',
      'free_trials', 'free_to_paid_upgrades', 'signups_within_1_day', 'subscriptions_within_1_day',
      'estimated_value',
    ]) {
      assert.ok(POST_STAT_FIELDS.includes(field), `${field} is missing`);
    }
  });

  test('covers churn and completion, which nothing else reports per post', () => {
    assert.ok(POST_STAT_FIELDS.includes('unsubscribes'));
    assert.ok(POST_STAT_FIELDS.includes('subscribers_finished_post'));
  });
});

describe('getPostStatsSchema', () => {
  test('accepts an empty call', () => {
    assert.deepEqual(getPostStatsSchema.parse({}), {});
  });

  test('accepts a sort, direction and page', () => {
    const args = {order_by: 'signups', order_direction: 'desc', limit: 50, offset: 100};

    assert.deepEqual(getPostStatsSchema.parse(args), args);
  });

  // The API answers 200 for an order_by it does not recognise and returns an arbitrary order, so a
  // typo would otherwise produce a ranking that looks authoritative and is not. The enum is the only
  // thing standing between the caller and that.
  test('rejects an order_by that is not a real field', () => {
    assert.throws(() => getPostStatsSchema.parse({order_by: 'signup'}), z.ZodError);
    assert.throws(() => getPostStatsSchema.parse({order_by: 'best'}), z.ZodError);
  });

  test('accepts every field as a sort key', () => {
    for (const order_by of POST_STAT_FIELDS) {
      assert.deepEqual(getPostStatsSchema.parse({order_by}), {order_by});
    }
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getPostStatsSchema.parse({from_date: '2026-01-01'}),
      (error) => /Unrecognized key/.test(error.message) && /from_date/.test(error.message)
    );
  });

  test('bounds limit and offset', () => {
    assert.throws(() => getPostStatsSchema.parse({limit: 0}), z.ZodError);
    assert.throws(() => getPostStatsSchema.parse({limit: 101}), z.ZodError);
    assert.throws(() => getPostStatsSchema.parse({offset: -1}), z.ZodError);
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getPostStatsSchema, {target: 'draft-7', io: 'input'});

    for (const field of ['order_by', 'order_direction', 'limit', 'offset']) {
      assert.ok(json.properties[field].description, `${field} has no description`);
    }

    assert.equal(json.additionalProperties, false);
  });

  test('publishes the sortable fields as an enum', () => {
    const json = z.toJSONSchema(getPostStatsSchema, {target: 'draft-7', io: 'input'});

    assert.deepEqual(json.properties.order_by.enum.sort(), [...POST_STAT_FIELDS].sort());
  });

  // There is no date filtering on this endpoint — verified: from_date/to_date leave `total`
  // unchanged at 863. Accepting them would imply a narrowing that never happens.
  test('exposes no date window, because the endpoint ignores one', () => {
    const json = z.toJSONSchema(getPostStatsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.properties.from_date, undefined);
    assert.equal(json.properties.to_date, undefined);
  });
});

describe('getPostStatsHandler — request shape', () => {
  test('GETs the email_stats endpoint, which is the per-post table', async () => {
    await getPostStatsHandler({});

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(sentUrl().pathname, '/api/v1/publication/stats/email_stats');
  });

  test('defaults to the most recent posts first', async () => {
    await getPostStatsHandler({});

    assert.equal(param('order_by'), 'post_date');
    assert.equal(param('order_direction'), 'desc');
  });

  test('defaults to the first page of 25', async () => {
    await getPostStatsHandler({});

    assert.equal(param('limit'), '25');
    assert.equal(param('offset'), '0');
  });

  test('sorts by the requested metric', async () => {
    await getPostStatsHandler({order_by: 'estimated_value'});

    assert.equal(param('order_by'), 'estimated_value');
    assert.equal(param('order_direction'), 'desc');
  });

  test('an explicit direction is used as given', async () => {
    await getPostStatsHandler({order_by: 'unsubscribes', order_direction: 'asc'});

    assert.equal(param('order_direction'), 'asc');
  });

  test('forwards limit and offset', async () => {
    await getPostStatsHandler({limit: 5, offset: 40});

    assert.equal(param('limit'), '5');
    assert.equal(param('offset'), '40');
  });

  // Sending one would be silently ignored, which is worse than not offering it: the caller would
  // believe the numbers covered a window they never did.
  test('sends no date parameters at all', async () => {
    await getPostStatsHandler({});

    assert.equal(sentUrl().searchParams.has('from_date'), false);
    assert.equal(sentUrl().searchParams.has('to_date'), false);
  });
});

describe('getPostStatsHandler — result', () => {
  test('returns the archive total alongside the page', async () => {
    const result = await getPostStatsHandler({});

    assert.equal(result.total, 863);
    assert.equal(result.returned, 2);
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
  });

  test('echoes the sort that produced the ranking', async () => {
    const result = await getPostStatsHandler({order_by: 'signups'});

    assert.equal(result.order_by, 'signups');
    assert.equal(result.order_direction, 'desc');
  });

  test('returns the posts with their metrics intact', async () => {
    const [first] = (await getPostStatsHandler({})).posts;

    assert.equal(first.title, 'MCP Server for Substack');
    assert.equal(first.signups, 42);
    assert.equal(first.subscribes, 6);
    assert.equal(first.estimated_value, 669.5023091726059);
    assert.equal(first.unsubscribes, 1);
    assert.equal(first.subscribers_finished_post, 610);
  });

  test('survives a response carrying no rows', async () => {
    msw.server.use(msw.postStatsHandler(() => HttpResponse.json({total: 0}, {status: 200})));

    const result = await getPostStatsHandler({});

    assert.deepEqual(result.posts, []);
    assert.equal(result.returned, 0);
  });

  // Sorting descending on a rate puts posts with no data first, because null sorts before numbers.
  // Pinned so the caveat in the description stays honest rather than drifting.
  test('does not reorder or filter what the API returned', async () => {
    msw.server.use(msw.postStatsHandler(() => HttpResponse.json({
      total: 3,
      rows: [{title: 'no data', open_rate: null}, {title: 'good', open_rate: 0.5}],
    }, {status: 200})));

    const {posts} = await getPostStatsHandler({order_by: 'open_rate'});

    assert.deepEqual(posts.map((post) => post.title), ['no data', 'good']);
  });
});

describe('getPostStatsHandler — errors and logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('throws ZodError on an invalid sort without issuing any request', async () => {
    await assert.rejects(
      () => getPostStatsHandler({order_by: 'nope'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates a Substack API error', async () => {
    msw.server.use(msw.postStatsHandler(() => new HttpResponse('boom', {status: 500})));

    const error = await getPostStatsHandler({}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 500\b/);
  });

  test('records the arguments it received', async () => {
    const lines = await captureLogs(() => getPostStatsHandler({order_by: 'signups'}));

    assert.deepEqual(find(lines, 'get_post_stats.start').args, {order_by: 'signups'});
  });

  test('records the sort and page it resolved, and what came back', async () => {
    const lines = await captureLogs(() => getPostStatsHandler({}));

    const done = find(lines, 'get_post_stats.done');
    assert.equal(done.order_by, 'post_date');
    assert.equal(done.order_direction, 'desc');
    assert.equal(done.total, 863);
    assert.equal(done.returned, 2);
  });

  test('records the validation issues when the arguments are rejected', async () => {
    const lines = await captureLogs(
      () => getPostStatsHandler({order_by: 'nope'}).catch(() => {})
    );

    assert.deepEqual(
      find(lines, 'get_post_stats.args.invalid').issues.map((issue) => issue.path.join('.')),
      ['order_by']
    );
  });

  test('never writes the session token to the log', async () => {
    const lines = await captureLogs(() => getPostStatsHandler({}));

    assert.doesNotMatch(JSON.stringify(lines), /test-session-token/);
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => getPostStatsHandler({}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
