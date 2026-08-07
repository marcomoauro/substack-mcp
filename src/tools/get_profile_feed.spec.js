import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getProfileFeedHandler, getProfileFeedSchema} from './get_profile_feed.js';
import {createMswServer, READER_FEED_RESPONSE} from '../../test/helpers/msw-server.js';
import {setTestEnv, TEST_ENV} from '../../test/helpers/env.js';

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

describe('getProfileFeedSchema', () => {
  test('needs no argument and defaults to everything', () => {
    assert.deepEqual(getProfileFeedSchema.parse({}), {type: 'all', limit: 20});
  });

  test('rejects a type outside the enum', () => {
    assert.throws(() => getProfileFeedSchema.parse({type: 'comments'}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getProfileFeedSchema.parse({userId: 1}),
      (error) => /Unrecognized key/.test(error.message) && /\buserId\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getProfileFeedSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('getProfileFeedHandler', () => {
  test('falls back to SUBSTACK_USER_ID so "my Notes" needs no argument', async () => {
    const result = await getProfileFeedHandler({});

    assert.equal(
      new URL(msw.requests.at(-1).url).pathname,
      `/api/v1/reader/feed/profile/${TEST_ENV.SUBSTACK_USER_ID}`
    );
    assert.equal(result.user_id, Number(TEST_ENV.SUBSTACK_USER_ID));
  });

  test('reads another user when given one', async () => {
    await getProfileFeedHandler({user_id: 22563751});

    assert.equal(
      new URL(msw.requests.at(-1).url).pathname,
      '/api/v1/reader/feed/profile/22563751'
    );
  });

  test('refuses when neither an argument nor a usable env var is present', async () => {
    const saved = process.env.SUBSTACK_USER_ID;
    process.env.SUBSTACK_USER_ID = 'not-a-number';

    try {
      await assert.rejects(() => getProfileFeedHandler({}), /user_id is required/);
      assert.equal(msw.requests.length, 0);
    } finally {
      process.env.SUBSTACK_USER_ID = saved;
    }
  });

  test('returns both notes and posts by default', async () => {
    const result = await getProfileFeedHandler({});

    assert.deepEqual(result.items.map((item) => item.type), ['note', 'post']);
    assert.ok(!('read_from_profile' in result));
  });

  // This filter is the whole reason the fork's separate `get_user_notes` tool was not ported: it is
  // the same endpoint with posts removed.
  test('filters to notes', async () => {
    const result = await getProfileFeedHandler({type: 'notes'});

    assert.equal(result.returned, 1);
    assert.equal(result.items[0].type, 'note');
  });

  test('filters to posts', async () => {
    const result = await getProfileFeedHandler({type: 'posts'});

    assert.equal(result.returned, 1);
    assert.equal(result.items[0].type, 'post');
  });

  // A limit of 20 that returns 1 note read 20 entries of which 1 was a note. Without this, the
  // result reads as "this account has written one Note".
  test('says how much of the page it read when filtering', async () => {
    const result = await getProfileFeedHandler({type: 'notes'});

    assert.equal(result.read_from_profile, 2);
    assert.match(result.note, /the page held 2 entries/);
  });

  test('omits the note when the filter removed nothing', async () => {
    msw.server.use(
      msw.profileFeedHandler(() =>
        HttpResponse.json({items: [READER_FEED_RESPONSE.items[0]], nextCursor: null}, {status: 200})
      )
    );

    const result = await getProfileFeedHandler({type: 'notes'});

    assert.equal(result.returned, 1);
    assert.ok(!('read_from_profile' in result));
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.profileFeedHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => getProfileFeedHandler({}), /SubstackAPIException: 404/);
  });
});
