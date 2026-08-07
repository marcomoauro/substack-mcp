import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getUserProfileHandler, getUserProfileSchema} from './get_user_profile.js';
import {createMswServer, USER_PROFILE_URL, USER_PROFILE_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('getUserProfileSchema', () => {
  test('takes no required argument and defaults to the projection', () => {
    assert.deepEqual(getUserProfileSchema.parse({}), {full: false});
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getUserProfileSchema.parse({user_id: 1}),
      (error) => /Unrecognized key/.test(error.message) && /\buser_id\b/.test(error.message)
    );
  });

  test('publishes a description for full', () => {
    const json = z.toJSONSchema(getUserProfileSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.ok(json.properties.full.description);
  });
});

describe('getUserProfileHandler', () => {
  // This endpoint lives on substack.com, not the publication host. Pointing it at the publication
  // answers 404, so the url is the assertion that matters most here — MSW is configured to error on
  // an unhandled request, which is what would catch the wrong base.
  test('requests substack.com, not the publication host', async () => {
    await getUserProfileHandler({});

    assert.equal(msw.requests.at(-1).url, USER_PROFILE_URL);
    assert.match(msw.requests.at(-1).url, /^https:\/\/substack\.com\//);
  });

  test('projects identity plus every publication the session has a role on', async () => {
    const result = await getUserProfileHandler({});

    assert.equal(result.id, 41640433);
    assert.equal(result.handle, 'testuser');
    assert.deepEqual(result.publications, [
      {role: 'admin', publication_id: 2150088, subdomain: 'test', name: 'Test Publication'},
      {role: 'contributor', publication_id: 2073698, subdomain: 'other', name: 'Other Publication'},
    ]);
    assert.equal(result.primary_publication_id, 2150088);
    // Counted rather than included: the array grows with every publication the account reads.
    assert.equal(result.subscription_count, 3);
    assert.ok(!('subscriptions' in result));
  });

  test('returns the raw payload untouched when full is set', async () => {
    const result = await getUserProfileHandler({full: true});

    assert.deepEqual(result, USER_PROFILE_RESPONSE);
    assert.equal(result.subscriptions.length, 3);
  });

  test('survives a profile with no publications', async () => {
    msw.server.use(
      msw.userProfileHandler(() => HttpResponse.json({id: 1, name: 'Reader'}, {status: 200}))
    );

    const result = await getUserProfileHandler({});

    assert.deepEqual(result.publications, []);
    assert.equal(result.subscription_count, 0);
    assert.equal(result.primary_publication_id, null);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.userProfileHandler(() => HttpResponse.json({}, {status: 401})));

    await assert.rejects(() => getUserProfileHandler({}), /SubstackAPIException: 401/);
  });
});
