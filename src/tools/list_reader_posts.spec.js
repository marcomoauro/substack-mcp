import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {listReaderPostsHandler, listReaderPostsSchema} from './list_reader_posts.js';
import {createMswServer, READER_POSTS_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('listReaderPostsSchema', () => {
  test('defaults the limit', () => {
    assert.deepEqual(listReaderPostsSchema.parse({}), {limit: 20});
  });

  test('bounds the limit at 100', () => {
    assert.throws(() => listReaderPostsSchema.parse({limit: 101}), z.ZodError);
  });

  // Paging here is a timestamp, not the `cursor` the rest of this API uses. Offering `cursor` would
  // invite a model to pass a value this endpoint ignores.
  test('rejects a cursor by name — this endpoint pages by timestamp', () => {
    assert.throws(
      () => listReaderPostsSchema.parse({cursor: 'x'}),
      (error) => /Unrecognized key/.test(error.message) && /\bcursor\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(listReaderPostsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('listReaderPostsHandler', () => {
  test('reads substack.com with the limit', async () => {
    await listReaderPostsHandler({limit: 5});

    const url = new URL(msw.requests.at(-1).url);

    assert.equal(url.origin, 'https://substack.com');
    assert.equal(url.pathname, '/api/v1/reader/posts');
    assert.equal(url.searchParams.get('limit'), '5');
    // A null `after` must never be serialized: `after=null` would be read as the literal string.
    assert.ok(!url.searchParams.has('after'));
  });

  test('forwards after when resuming', async () => {
    await listReaderPostsHandler({after: '2026-08-05T07:01:55.441Z'});

    assert.equal(
      new URL(msw.requests.at(-1).url).searchParams.get('after'),
      '2026-08-05T07:01:55.441Z'
    );
  });

  test('joins each post to its publication and keeps the reading state', async () => {
    const result = await listReaderPostsHandler({});

    assert.equal(result.returned, 1);
    assert.deepEqual(result.posts[0], {
      id: 205705837,
      title: 'REST API Authentication Methods Clearly Explained',
      subtitle: 'A subtitle',
      publication: 'Level Up Coding',
      publication_id: 5152101,
      author: 'The Author',
      published_at: '2026-08-05T18:25:08.238Z',
      audience: 'everyone',
      type: 'newsletter',
      url: 'https://blog.levelupcoding.com/p/rest-api-authentication-methods',
      wordcount: 1200,
      reactions: 40,
      comments: 3,
      restacks: 5,
      is_read: true,
      read_progress: 0.5,
      is_saved: false,
    });
  });

  // The Inbox really does send every post whole. A page of 20 unprojected entries is hundreds of KB
  // of content nobody has asked to read yet.
  test('drops the bodies the Inbox attaches to every post', async () => {
    assert.ok(READER_POSTS_RESPONSE.posts[0].body_html, 'the fixture must carry one to drop');

    const result = await listReaderPostsHandler({});

    assert.ok(!('body_html' in result.posts[0]));
    assert.ok(!('body_json' in result.posts[0]));
  });

  // Paging is the last inboxItems entry's content_date, not the top-level `cursor`, which is null.
  test('takes next_after from the last inbox item', async () => {
    const result = await listReaderPostsHandler({});

    assert.equal(result.more, true);
    assert.equal(result.next_after, '2026-08-05T07:01:55.441Z');
  });

  test('reports no more pages when the inbox items run out', async () => {
    msw.server.use(
      msw.readerPostsHandler(() =>
        HttpResponse.json({...READER_POSTS_RESPONSE, more: true, inboxItems: []}, {status: 200})
      )
    );

    const result = await listReaderPostsHandler({});

    assert.equal(result.more, false);
    assert.ok(!('next_after' in result));
  });

  test('survives a post whose publication is not in the response', async () => {
    msw.server.use(
      msw.readerPostsHandler(() =>
        HttpResponse.json({...READER_POSTS_RESPONSE, publications: []}, {status: 200})
      )
    );

    const result = await listReaderPostsHandler({});

    assert.equal(result.posts[0].publication, null);
    assert.equal(result.posts[0].publication_id, 5152101);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.readerPostsHandler(() => HttpResponse.json({}, {status: 500})));

    await assert.rejects(() => listReaderPostsHandler({}), /SubstackAPIException: 500/);
  });
});
