import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {listPostsHandler, listPostsSchema} from './list_posts.js';
import {createMswServer, POSTS_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('listPostsSchema', () => {
  test('requires a status', () => {
    assert.throws(() => listPostsSchema.parse({}), z.ZodError);
  });

  test('accepts the three statuses the API exposes', () => {
    for (const status of ['drafts', 'published', 'scheduled']) {
      assert.deepEqual(listPostsSchema.parse({status}), {status});
    }
  });

  test('rejects any other status', () => {
    assert.throws(() => listPostsSchema.parse({status: 'archived'}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => listPostsSchema.parse({status: 'drafts', search: 'x', q: 'y'}),
      (error) => /Unrecognized key/.test(error.message) && /q/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(listPostsSchema, {target: 'draft-7', io: 'input'});

    for (const field of ['status', 'search', 'limit', 'offset', 'sort_direction']) {
      assert.ok(json.properties[field].description, `${field} has no description`);
    }

    assert.equal(json.additionalProperties, false);
  });
});

describe('listPostsHandler — request shape', () => {
  test('GETs the post_management path for the requested status', async () => {
    await listPostsHandler({status: 'published'});

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(sentUrl().pathname, '/api/v1/post_management/published');
  });

  test('drafts default to sorting by last update, newest first', async () => {
    await listPostsHandler({status: 'drafts'});

    assert.equal(param('order_by'), 'draft_updated_at');
    assert.equal(param('order_direction'), 'desc');
  });

  test('published posts default to sorting by publication date, newest first', async () => {
    await listPostsHandler({status: 'published'});

    assert.equal(param('order_by'), 'post_date');
    assert.equal(param('order_direction'), 'desc');
  });

  // Two things at once: `scheduled` is the one status whose natural order is ascending — the next
  // post to go out first — and it is also the one the API refuses outright without an order_by.
  test('scheduled posts sort by trigger time, soonest first', async () => {
    await listPostsHandler({status: 'scheduled'});

    assert.equal(param('order_by'), 'trigger_at');
    assert.equal(param('order_direction'), 'asc');
  });

  test('every status sends an order_by, which the API requires', async () => {
    for (const status of ['drafts', 'published', 'scheduled']) {
      msw.requests.length = 0;
      await listPostsHandler({status});

      assert.ok(param('order_by'), `${status} sent no order_by`);
    }
  });

  test('an explicit sort_direction overrides the default', async () => {
    await listPostsHandler({status: 'scheduled', sort_direction: 'desc'});

    assert.equal(param('order_direction'), 'desc');
    assert.equal(param('order_by'), 'trigger_at');
  });

  test('defaults to the first page of 25', async () => {
    await listPostsHandler({status: 'drafts'});

    assert.equal(param('limit'), '25');
    assert.equal(param('offset'), '0');
  });

  test('forwards limit and offset', async () => {
    await listPostsHandler({status: 'drafts', limit: 5, offset: 10});

    assert.equal(param('limit'), '5');
    assert.equal(param('offset'), '10');
  });

  test('sends the search term as the `query` parameter', async () => {
    await listPostsHandler({status: 'published', search: 'mcp'});

    assert.equal(param('query'), 'mcp');
  });

  // A null search must not reach the URL as the string "null", which would be searched for
  // literally and match nothing.
  test('omits `query` when no search term is given', async () => {
    await listPostsHandler({status: 'published'});

    assert.equal(sentUrl().searchParams.has('query'), false);
  });
});

describe('listPostsHandler — result', () => {
  test('returns the total, the page size and the posts', async () => {
    const result = await listPostsHandler({status: 'published'});

    assert.equal(result.status, 'published');
    assert.equal(result.total, POSTS_RESPONSE.total);
    assert.equal(result.returned, 2);
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
    assert.equal(result.posts.length, 2);
  });

  // The raw post objects carry bylines, reactions, per-post stats and more — tens of fields each,
  // most of them noise for a caller listing posts. The projection is documented in the schema
  // description so nothing is dropped without the caller being told.
  test('projects each post onto the documented field set', async () => {
    const result = await listPostsHandler({status: 'published'});

    assert.deepEqual(result.posts[0], {
      id: 10,
      title: 'Published one',
      slug: 'published-one',
      is_published: true,
      audience: 'everyone',
    });
  });

  test('keeps the fields the projection names and drops the rest', async () => {
    msw.server.use(msw.postsHandler(() => HttpResponse.json({
      posts: [{
        id: 1,
        title: 'T',
        draft_title: 'DT',
        slug: 's',
        type: 'newsletter',
        audience: 'everyone',
        is_published: false,
        post_date: '2026-01-01',
        trigger_at: '2026-02-01',
        draft_updated_at: '2026-01-02',
        email_sent_at: null,
        should_send_email: true,
        section_name: 'Main',
        reaction_count: 3,
        comment_count: 1,
        bylines: [{id: 1, name: 'noise'}],
        reactions: {'❤': 3},
        top_exclusions: ['noise'],
        headlineTest: {noise: true},
      }],
      total: 1,
    }, {status: 200})));

    const [post] = (await listPostsHandler({status: 'drafts'})).posts;

    assert.equal(post.title, 'T');
    assert.equal(post.draft_title, 'DT');
    assert.equal(post.trigger_at, '2026-02-01');
    assert.equal(post.reaction_count, 3);
    assert.equal(post.bylines, undefined);
    assert.equal(post.reactions, undefined);
    assert.equal(post.headlineTest, undefined);
  });

  test('survives a response carrying no posts array', async () => {
    msw.server.use(msw.postsHandler(() => HttpResponse.json({total: 0}, {status: 200})));

    const result = await listPostsHandler({status: 'scheduled'});

    assert.deepEqual(result.posts, []);
    assert.equal(result.returned, 0);
  });
});

describe('listPostsHandler — errors and logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('throws ZodError on a malformed call without issuing any request', async () => {
    await assert.rejects(
      () => listPostsHandler({status: 'nope'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates a Substack API error', async () => {
    msw.server.use(msw.postsHandler(() => new HttpResponse('bad request', {status: 400})));

    const error = await listPostsHandler({status: 'scheduled'}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 400\b/);
  });

  test('records the arguments and what came back', async () => {
    const lines = await captureLogs(() => listPostsHandler({status: 'published', search: 'mcp'}));

    assert.deepEqual(find(lines, 'list_posts.start').args, {status: 'published', search: 'mcp'});

    const done = find(lines, 'list_posts.done');
    assert.equal(done.status, 'published');
    assert.equal(done.total, POSTS_RESPONSE.total);
    assert.equal(done.returned, 2);
  });

  test('records the sort it chose, which the caller never sees otherwise', async () => {
    const lines = await captureLogs(() => listPostsHandler({status: 'scheduled'}));

    const sort = find(lines, 'list_posts.sort');
    assert.equal(sort.order_by, 'trigger_at');
    assert.equal(sort.order_direction, 'asc');
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => listPostsHandler({status: 'drafts'}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
