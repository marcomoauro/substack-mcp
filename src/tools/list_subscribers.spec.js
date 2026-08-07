import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {listSubscribersHandler, listSubscribersSchema} from './list_subscribers.js';
import {
  createMswServer,
  SUBSCRIBER_STATS_URL,
  SUBSCRIBER_STATS_RESPONSE,
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

const sentFilters = () => msw.requests.at(-1).body.filters;

describe('listSubscribersSchema', () => {
  test('accepts an empty call', () => {
    assert.deepEqual(listSubscribersSchema.parse({}), {});
  });

  test('accepts a filter, search, sort and pagination together', () => {
    const args = {
      filters: [{column: 'subscription_type', operator: 'is', value: 'paid'}],
      search: 'gmail',
      sort_by: 'subscription_created_at',
      sort_direction: 'desc',
      limit: 50,
      offset: 100,
    };

    assert.deepEqual(listSubscribersSchema.parse(args), args);
  });

  // strictObject, so a plausible-but-wrong key is reported rather than dropped. A model that
  // sends `query` instead of `search` has to be told that, not just that nothing happened.
  test('rejects an unknown top-level key by name', () => {
    assert.throws(
      () => listSubscribersSchema.parse({query: 'gmail'}),
      (error) => /Unrecognized key/.test(error.message) && /query/.test(error.message)
    );
  });

  test('rejects an unknown key inside a filter', () => {
    assert.throws(
      () => listSubscribersSchema.parse({
        filters: [{column: 'subscription_type', relation: 'is', value: 'paid'}],
      }),
      (error) => /Unrecognized key/.test(error.message) && /relation/.test(error.message)
    );
  });

  // The column list is an enum so it reaches the client in the published JSON Schema: the model
  // sees the 48 valid names instead of guessing them.
  test('rejects a column that does not exist', () => {
    assert.throws(
      () => listSubscribersSchema.parse({
        filters: [{column: 'email', operator: 'is', value: 'a@b.c'}],
      }),
      z.ZodError
    );
  });

  test('rejects an operator that does not exist', () => {
    assert.throws(
      () => listSubscribersSchema.parse({
        filters: [{column: 'user_name', operator: 'like', value: 'Bob'}],
      }),
      z.ZodError
    );
  });

  test('accepts a list value for the list operators', () => {
    const args = {filters: [{column: 'subscription_type', operator: 'is_any_of', value: ['free', 'paid']}]};

    assert.deepEqual(listSubscribersSchema.parse(args), args);
  });

  test('caps limit at 100 and refuses a negative offset', () => {
    assert.throws(() => listSubscribersSchema.parse({limit: 101}), z.ZodError);
    assert.throws(() => listSubscribersSchema.parse({offset: -1}), z.ZodError);
  });

  test('publishes a description for every field a caller has to fill in', () => {
    const json = z.toJSONSchema(listSubscribersSchema, {target: 'draft-7', io: 'input'});

    for (const field of ['filters', 'search', 'sort_by', 'sort_direction', 'limit', 'offset']) {
      assert.ok(json.properties[field].description, `${field} has no description`);
    }

    assert.equal(json.additionalProperties, false);
  });
});

describe('listSubscribersHandler — request shape', () => {
  test('sends one POST to the subscriber-stats endpoint', async () => {
    await listSubscribersHandler({});

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].method, 'POST');
    assert.equal(msw.requests[0].url, SUBSCRIBER_STATS_URL);
  });

  test('an empty call asks for the default page with no filters', async () => {
    await listSubscribersHandler({});

    assert.deepEqual(msw.requests[0].body, {filters: {}, limit: 25, offset: 0});
  });

  test('translates a filter into the flat suffixed key the API expects', async () => {
    await listSubscribersHandler({
      filters: [{column: 'num_email_opens_last_30d', operator: 'gt', value: 2}],
    });

    assert.deepEqual(sentFilters(), {num_email_opens_last_30d_gt: 2});
  });

  test('ANDs several filters into several keys', async () => {
    await listSubscribersHandler({
      filters: [
        {column: 'subscription_type', operator: 'is', value: 'paid'},
        {column: 'country', operator: 'is', value: 'IT'},
      ],
    });

    assert.deepEqual(sentFilters(), {subscription_type: 'paid', country_string_is: 'IT'});
  });

  test('puts the search term inside filters, where the API reads it', async () => {
    await listSubscribersHandler({search: 'gmail'});

    assert.deepEqual(sentFilters(), {search: 'gmail'});
  });

  test('passes the sort through as the direction-specific key', async () => {
    await listSubscribersHandler({sort_by: 'total_revenue_generated', sort_direction: 'asc'});

    assert.deepEqual(sentFilters(), {order_by: 'total_revenue_generated'});
  });

  test('forwards limit and offset', async () => {
    await listSubscribersHandler({limit: 100, offset: 200});

    assert.equal(msw.requests[0].body.limit, 100);
    assert.equal(msw.requests[0].body.offset, 200);
  });
});

describe('listSubscribersHandler — result', () => {
  test('returns the total count alongside the page', async () => {
    const result = await listSubscribersHandler({});

    assert.equal(result.count, 2);
    assert.equal(result.returned, 2);
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
    assert.deepEqual(result.subscribers, SUBSCRIBER_STATS_RESPONSE.subscribers);
  });

  // `count` is the total matching the filters, not the size of the page, which is what makes a
  // limit:1 call a cheap way to count a segment.
  test('count reflects the whole segment, not the page', async () => {
    msw.server.use(msw.subscriberStatsHandler(() => HttpResponse.json(
      {count: 1617, subscribers: [SUBSCRIBER_STATS_RESPONSE.subscribers[0]]},
      {status: 200}
    )));

    const result = await listSubscribersHandler({limit: 1});

    assert.equal(result.count, 1617);
    assert.equal(result.returned, 1);
  });

  test('survives a response carrying no subscribers array', async () => {
    msw.server.use(msw.subscriberStatsHandler(() => HttpResponse.json({count: 0}, {status: 200})));

    const result = await listSubscribersHandler({});

    assert.deepEqual(result.subscribers, []);
    assert.equal(result.returned, 0);
  });
});

describe('listSubscribersHandler — validation', () => {
  test('refuses an operator the column type does not accept, naming the alternatives', async () => {
    const error = await listSubscribersHandler({
      filters: [{column: 'user_email_address', operator: 'gt', value: 1}],
    }).catch((e) => e);

    assert.match(error.message, /does not apply/i);
    assert.match(error.message, /contains/);
    assert.equal(msw.requests.length, 0);
  });

  test('refuses an invalid enum value before spending a request', async () => {
    const error = await listSubscribersHandler({
      filters: [{column: 'subscription_type', operator: 'is', value: 'premium'}],
    }).catch((e) => e);

    assert.match(error.message, /premium/);
    assert.match(error.message, /free_trial/);
    assert.equal(msw.requests.length, 0);
  });

  test('throws ZodError on a malformed call without issuing any request', async () => {
    await assert.rejects(
      () => listSubscribersHandler({limit: 'many'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates a Substack API error', async () => {
    msw.server.use(msw.subscriberStatsHandler(() => new HttpResponse('nope', {status: 400})));

    const error = await listSubscribersHandler({}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });
});

describe('listSubscribersHandler — logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('records the arguments it received', async () => {
    const args = {filters: [{column: 'subscription_type', operator: 'is', value: 'free'}], limit: 5};
    const lines = await captureLogs(() => listSubscribersHandler(args));

    assert.deepEqual(find(lines, 'list_subscribers.start').args, args);
  });

  // The translated key is the thing to grep for when the API answers 400: it says exactly what
  // was sent, which the structured arguments alone do not.
  test('records each filter with the key it was translated into', async () => {
    const lines = await captureLogs(() => listSubscribersHandler({
      filters: [{column: 'num_comments', operator: 'gte', value: 1}],
    }));

    const filter = find(lines, 'subscriber_query.filter');
    assert.equal(filter.column, 'num_comments');
    assert.equal(filter.operator, 'gte');
    assert.equal(filter.key, 'num_comments_gte');
  });

  test('records how many subscribers came back out of how many matched', async () => {
    const lines = await captureLogs(() => listSubscribersHandler({}));

    const done = find(lines, 'list_subscribers.done');
    assert.equal(done.count, 2);
    assert.equal(done.returned, 2);
  });

  test('records the reason a filter was refused', async () => {
    const lines = await captureLogs(() => listSubscribersHandler({
      filters: [{column: 'user_email_address', operator: 'gt', value: 1}],
    }).catch(() => {}));

    assert.match(find(lines, 'list_subscribers.query.invalid').error.message, /does not apply/i);
  });

  test('never writes the session token to the log', async () => {
    const lines = await captureLogs(() => listSubscribersHandler({}));

    assert.equal(find(lines, 'substack.request').headers.Cookie, '***');
    assert.doesNotMatch(JSON.stringify(lines), /test-session-token/);
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => listSubscribersHandler({}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
