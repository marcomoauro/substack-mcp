import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {listSubscriptionsHandler, listSubscriptionsSchema} from './list_subscriptions.js';
import {createMswServer, SUBSCRIPTIONS_URL, SUBSCRIPTIONS_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('listSubscriptionsSchema', () => {
  test('defaults the limit and active_only', () => {
    assert.deepEqual(listSubscriptionsSchema.parse({}), {limit: 100, active_only: true});
  });

  test('bounds the limit at 500', () => {
    assert.throws(() => listSubscriptionsSchema.parse({limit: 501}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => listSubscriptionsSchema.parse({cursor: 'x'}),
      (error) => /Unrecognized key/.test(error.message) && /\bcursor\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(listSubscriptionsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('listSubscriptionsHandler', () => {
  test('reads substack.com, not the publication host', async () => {
    await listSubscriptionsHandler({});

    assert.match(msw.requests.at(-1).url, /^https:\/\/substack\.com\//);
    assert.equal(new URL(msw.requests.at(-1).url).pathname, new URL(SUBSCRIPTIONS_URL).pathname);
  });

  // `items` mixes 'subscription' with 'label' (a section header) and 'add_more' (a UI affordance).
  // Mapping the array straight through yields entries with no publication at all.
  test('keeps only the subscription entries, dropping label and add_more', async () => {
    const result = await listSubscriptionsHandler({active_only: false});

    assert.equal(result.returned, 3);
    assert.ok(result.subscriptions.every((subscription) => subscription.publication_id));
    assert.ok(result.subscriptions.every((subscription) => subscription.name));
  });

  // The `pub`/`subscription` presence check on the next line already drops today's label and
  // add_more entries, since neither carries either field — so the type check above it is only load
  // bearing for an entry that *does* carry a publication without being a subscription. That is the
  // hazard it exists for: Substack adds item types to this array, and a recommendation block with a
  // `pub` attached would otherwise be reported as something this account subscribes to.
  test('drops a non-subscription entry even when it carries a publication', async () => {
    msw.server.use(
      msw.subscriptionsHandler(() =>
        HttpResponse.json(
          {
            items: [
              SUBSCRIPTIONS_RESPONSE.items[1],
              {
                type: 'recommendation',
                pub: {id: 4444, subdomain: 'recommended', name: 'Just A Recommendation'},
                subscription: {id: 444, membership_state: 'none', paused: null, expiry: null},
              },
            ],
            nextCursor: null,
          },
          {status: 200}
        )
      )
    );

    const result = await listSubscriptionsHandler({active_only: false});

    assert.equal(result.returned, 1);
    assert.deepEqual(result.subscriptions.map((s) => s.subdomain), ['refactoring']);
  });

  test('projects each subscription with its plan and state', async () => {
    const result = await listSubscriptionsHandler({});

    const refactoring = result.subscriptions.find((s) => s.subdomain === 'refactoring');

    assert.deepEqual(refactoring, {
      subscription_id: 111,
      publication_id: 5152101,
      name: 'Refactoring',
      author: 'Luca Rossi',
      subdomain: 'refactoring',
      url: 'https://refactoring.fm',
      membership_state: 'subscribed',
      type: 'free',
      is_founding: false,
      is_favorite: false,
      paused: false,
      expires_at: '2121-10-24T19:50:43.886Z',
      emails_disabled: false,
    });
  });

  // `paused` comes back as null rather than false, so a `=== false` test would drop every active
  // subscription. And a free subscription carries a far-future expiry, so a present expiry is not
  // itself evidence of an expired term.
  test('excludes the paused and the expired, keeping a far-future expiry', async () => {
    const result = await listSubscriptionsHandler({active_only: true});

    assert.equal(result.returned, 1);
    assert.equal(result.subscriptions[0].subdomain, 'refactoring');
    assert.equal(result.skipped_inactive, 2);
  });

  test('includes them when active_only is off', async () => {
    const result = await listSubscriptionsHandler({active_only: false});

    assert.deepEqual(
      result.subscriptions.map((s) => s.subdomain).sort(),
      ['expired-pub', 'paused-pub', 'refactoring']
    );
    assert.ok(!('skipped_inactive' in result));
  });

  test('follows the cursor across pages and counts a publication once', async () => {
    let call = 0;

    msw.server.use(
      msw.subscriptionsHandler(() => {
        call += 1;

        // The same publication on both pages: the Map is what keeps it from being counted twice.
        return HttpResponse.json(
          call === 1
            ? {items: SUBSCRIPTIONS_RESPONSE.items, nextCursor: 'page-2'}
            : {items: [SUBSCRIPTIONS_RESPONSE.items[1]], nextCursor: null},
          {status: 200}
        );
      })
    );

    const result = await listSubscriptionsHandler({active_only: false});

    assert.equal(result.pages_fetched, 2);
    assert.equal(result.returned, 3);
  });

  // A server handing back the same cursor forever would otherwise page until the process died.
  test('stops when the cursor stops advancing', async () => {
    msw.server.use(
      msw.subscriptionsHandler(() =>
        HttpResponse.json({items: SUBSCRIPTIONS_RESPONSE.items, nextCursor: 'stuck'}, {status: 200})
      )
    );

    const result = await listSubscriptionsHandler({active_only: false});

    assert.equal(result.pages_fetched, 2, 'the repeated cursor must end the loop');
  });

  test('stops at the requested limit', async () => {
    const result = await listSubscriptionsHandler({limit: 1, active_only: false});

    assert.equal(result.returned, 1);
  });

  test('sorts by publication name', async () => {
    const result = await listSubscriptionsHandler({active_only: false});

    assert.deepEqual(
      result.subscriptions.map((s) => s.name),
      ['A Paused One', 'An Expired One', 'Refactoring']
    );
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.subscriptionsHandler(() => HttpResponse.json({}, {status: 401})));

    await assert.rejects(() => listSubscriptionsHandler({}), /SubstackAPIException: 401/);
  });
});
