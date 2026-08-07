import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubscriberQuery,
  SUBSCRIBER_COLUMNS,
  OPERATORS_BY_TYPE,
} from './SubscriberQuery.js';
import {setTestEnv} from '../../../test/helpers/env.js';
import {captureLogs} from '../../../test/helpers/capture-logs.js';

// The module logs, so the level has to be silenced or the lines land on the reporter.
let restoreEnv;
before(() => {
  restoreEnv = setTestEnv();
});
after(() => restoreEnv());

const filtersOf = (input) => buildSubscriberQuery(input).filters;

describe('SUBSCRIBER_COLUMNS', () => {
  // The count is the whole point of the reconnaissance: 48 columns were enumerated from the
  // publisher bundle and every one of them was confirmed against the live API. A column
  // silently disappearing from the table is a capability silently disappearing from the tool.
  test('covers all 48 filterable columns', () => {
    assert.equal(Object.keys(SUBSCRIBER_COLUMNS).length, 48);
  });

  test('gives every column a type that has an operator set', () => {
    for (const [column, {type}] of Object.entries(SUBSCRIBER_COLUMNS)) {
      assert.ok(OPERATORS_BY_TYPE[type], `${column} has unknown type ${type}`);
    }
  });

  test('gives every column a human label', () => {
    for (const [column, {label}] of Object.entries(SUBSCRIBER_COLUMNS)) {
      assert.equal(typeof label, 'string', `${column} has no label`);
      assert.ok(label.length > 0, `${column} has an empty label`);
    }
  });
});

describe('buildSubscriberQuery — pagination', () => {
  test('defaults to the first page', () => {
    assert.deepEqual(buildSubscriberQuery({}), {filters: {}, limit: 25, offset: 0});
  });

  test('passes limit and offset through', () => {
    const query = buildSubscriberQuery({limit: 100, offset: 250});

    assert.equal(query.limit, 100);
    assert.equal(query.offset, 250);
  });
});

describe('buildSubscriberQuery — operator suffixes', () => {
  test('Int "is" uses the empty suffix', () => {
    assert.deepEqual(
      filtersOf({filters: [{column: 'num_comments', operator: 'is', value: 3}]}),
      {num_comments: 3}
    );
  });

  test('Int "is_not" uses _distinct_from', () => {
    assert.deepEqual(
      filtersOf({filters: [{column: 'num_comments', operator: 'is_not', value: 0}]}),
      {num_comments_distinct_from: 0}
    );
  });

  test('Int comparisons map onto _gt _gte _lt _lte', () => {
    const built = filtersOf({
      filters: [
        {column: 'num_email_opens_last_30d', operator: 'gt', value: 1},
        {column: 'num_email_opens_last_7d', operator: 'gte', value: 2},
        {column: 'num_comments', operator: 'lt', value: 3},
        {column: 'num_shares', operator: 'lte', value: 4},
      ],
    });

    assert.deepEqual(built, {
      num_email_opens_last_30d_gt: 1,
      num_email_opens_last_7d_gte: 2,
      num_comments_lt: 3,
      num_shares_lte: 4,
    });
  });

  // String "is" is _string_is, not the empty suffix — the empty suffix on a String column is
  // one of the combinations the API answers with a 400.
  test('String operators use the string-specific suffixes', () => {
    const built = filtersOf({
      filters: [
        {column: 'user_email_address', operator: 'is', value: 'a@b.c'},
        {column: 'user_name', operator: 'is_not', value: 'Bob'},
        {column: 'country', operator: 'contains', value: 'IT'},
        {column: 'state', operator: 'starts_with', value: 'Lom'},
        {column: 'stripe_plan_name', operator: 'ends_with', value: 'ly'},
      ],
    });

    assert.deepEqual(built, {
      user_email_address_string_is: 'a@b.c',
      user_name_string_not: 'Bob',
      country_similar_to: 'IT',
      state_starts_with: 'Lom',
      stripe_plan_name_ends_with: 'ly',
    });
  });

  // The asymmetry worth pinning: on a DateTime "is before" is _lt, but "is on or before" is
  // _is_on_or_before rather than the _lte an Int would use.
  test('DateTime operators map onto the date-specific suffixes', () => {
    const built = filtersOf({
      filters: [
        {column: 'subscription_created_at', operator: 'is_after', value: '2026-01-01'},
        {column: 'last_opened_at', operator: 'is_on_or_after', value: '2026-01-02'},
        {column: 'last_clicked_at', operator: 'is_before', value: '2026-01-03'},
        {column: 'first_payment_at', operator: 'is_on', value: '2026-01-04'},
        {column: 'unsubscribed_at', operator: 'is_on_or_before', value: '2026-01-05'},
      ],
    });

    assert.deepEqual(built, {
      subscription_created_at_gt: '2026-01-01',
      last_opened_at_gte: '2026-01-02',
      last_clicked_at_lt: '2026-01-03',
      first_payment_at_is_on: '2026-01-04',
      unsubscribed_at_is_on_or_before: '2026-01-05',
    });
  });

  test('array columns use the includes_* suffixes', () => {
    const built = filtersOf({
      filters: [
        {column: 'tag_ids', operator: 'includes_any', value: [1, 2]},
        {column: 'emails_enabled', operator: 'includes_none', value: ['3']},
      ],
    });

    assert.deepEqual(built, {tag_ids_includes_any: [1, 2], emails_enabled_includes_none: ['3']});
  });

  // Two enum columns, two different "is not" suffixes. subscription_type is the only column in
  // the whole table that uses _not.
  test('subscription_type "is_not" uses _not while group_membership uses _distinct_from', () => {
    assert.deepEqual(
      filtersOf({filters: [{column: 'subscription_type', operator: 'is_not', value: 'free'}]}),
      {subscription_type_not: 'free'}
    );

    assert.deepEqual(
      filtersOf({filters: [{column: 'group_membership', operator: 'is_not', value: 'none'}]}),
      {group_membership_distinct_from: 'none'}
    );
  });

  test('"is_any_of" uses _in', () => {
    assert.deepEqual(
      filtersOf({filters: [{column: 'subscription_type', operator: 'is_any_of', value: ['free', 'paid']}]}),
      {subscription_type_in: ['free', 'paid']}
    );
  });
});

describe('buildSubscriberQuery — combining', () => {
  test('several filters become several keys, which the API ANDs', () => {
    const built = filtersOf({
      filters: [
        {column: 'subscription_type', operator: 'is', value: 'paid'},
        {column: 'num_email_opens_last_30d', operator: 'gt', value: 2},
      ],
    });

    assert.deepEqual(built, {subscription_type: 'paid', num_email_opens_last_30d_gt: 2});
  });

  test('the same column can carry two different operators', () => {
    const built = filtersOf({
      filters: [
        {column: 'subscription_created_at', operator: 'is_after', value: '2026-01-01'},
        {column: 'subscription_created_at', operator: 'is_before', value: '2026-06-01'},
      ],
    });

    assert.deepEqual(built, {
      subscription_created_at_gt: '2026-01-01',
      subscription_created_at_lt: '2026-06-01',
    });
  });

  // Two identical column+operator pairs collapse onto one key, so one of the two conditions
  // would vanish. Silently dropping half of what the caller asked for is worse than refusing.
  test('rejects the same column and operator twice instead of dropping one', () => {
    assert.throws(
      () => filtersOf({
        filters: [
          {column: 'num_comments', operator: 'gt', value: 1},
          {column: 'num_comments', operator: 'gt', value: 5},
        ],
      }),
      /duplicate/i
    );
  });
});

describe('buildSubscriberQuery — search and sort', () => {
  // Verified against the live API: a top-level `search` is ignored and returns the unfiltered
  // count, so it has to travel inside `filters` alongside the columns.
  test('search travels inside filters, not next to limit', () => {
    const query = buildSubscriberQuery({search: 'gmail'});

    assert.deepEqual(query.filters, {search: 'gmail'});
    assert.equal(query.search, undefined);
  });

  test('descending sort uses order_by_desc_nulls_last', () => {
    assert.deepEqual(
      filtersOf({sort_by: 'subscription_created_at', sort_direction: 'desc'}),
      {order_by_desc_nulls_last: 'subscription_created_at'}
    );
  });

  test('ascending sort uses order_by', () => {
    assert.deepEqual(
      filtersOf({sort_by: 'total_revenue_generated', sort_direction: 'asc'}),
      {order_by: 'total_revenue_generated'}
    );
  });

  test('sort defaults to descending', () => {
    assert.deepEqual(
      filtersOf({sort_by: 'subscription_created_at'}),
      {order_by_desc_nulls_last: 'subscription_created_at'}
    );
  });

  test('sorting by an unknown column is refused', () => {
    assert.throws(() => filtersOf({sort_by: 'nope'}), /unknown column.*nope/i);
  });

  test('search, sort and filters coexist', () => {
    const built = filtersOf({
      search: 'gmail',
      sort_by: 'subscription_created_at',
      filters: [{column: 'subscription_type', operator: 'is', value: 'free'}],
    });

    assert.deepEqual(built, {
      subscription_type: 'free',
      search: 'gmail',
      order_by_desc_nulls_last: 'subscription_created_at',
    });
  });
});

describe('buildSubscriberQuery — logging', () => {
  // The assembled payload is what the API answers 400 about, and the structured arguments alone
  // do not show it: the whole point of this module is that the two look nothing alike.
  test('records the payload it assembled', async () => {
    const lines = await captureLogs(() => buildSubscriberQuery({
      filters: [{column: 'subscription_type', operator: 'is', value: 'free'}],
      limit: 10,
    }));

    const built = lines.find((entry) => entry.msg === 'subscriber_query.built');
    assert.ok(built, `expected a subscriber_query.built log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    assert.deepEqual(built.query, {filters: {subscription_type: 'free'}, limit: 10, offset: 0});
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => buildSubscriberQuery({}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});

describe('buildSubscriberQuery — validation', () => {
  // The API answers 400 with no usable explanation for all three of these. Catching them here
  // is what turns a dead end into a message a model can act on.
  test('an unknown column is refused and named', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'subscriber_email', operator: 'is', value: 'x'}]}),
      /unknown column.*subscriber_email/i
    );
  });

  test('an operator the column type does not accept is refused', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'user_email_address', operator: 'gt', value: 1}]}),
      /gt/
    );
  });

  test('the refusal lists the operators that would have worked', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'subscription_created_at', operator: 'lte', value: 'x'}]}),
      /is_on_or_before/
    );
  });

  test('an invalid enum value is refused and the allowed values listed', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'subscription_type', operator: 'is', value: 'premium'}]}),
      /premium.*free_trial|free_trial.*premium/s
    );
  });

  test('a valid enum value passes', () => {
    for (const value of ['paid', 'free', 'founding', 'comp', 'gift', 'free_trial', 'iap']) {
      assert.deepEqual(
        filtersOf({filters: [{column: 'subscription_type', operator: 'is', value}]}),
        {[`subscription_type`]: value}
      );
    }
  });

  test('is_any_of requires an array', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'subscription_type', operator: 'is_any_of', value: 'free'}]}),
      /array/i
    );
  });

  test('includes_any requires an array', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'tag_ids', operator: 'includes_any', value: 1}]}),
      /array/i
    );
  });

  test('a scalar operator rejects an array', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'num_comments', operator: 'gt', value: [1]}]}),
      /array/i
    );
  });

  test('enum values inside is_any_of are validated too', () => {
    assert.throws(
      () => filtersOf({filters: [{column: 'subscription_type', operator: 'is_any_of', value: ['free', 'premium']}]}),
      /premium/
    );
  });
});
