import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getPostCommentsHandler, getPostCommentsSchema} from './get_post_comments.js';
import {createMswServer, POST_COMMENTS_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('getPostCommentsSchema', () => {
  test('requires a post_id and defaults the limit', () => {
    assert.throws(() => getPostCommentsSchema.parse({}), z.ZodError);
    assert.deepEqual(getPostCommentsSchema.parse({post_id: 1}), {post_id: 1, limit: 50});
  });

  test('bounds the limit at 100', () => {
    assert.throws(() => getPostCommentsSchema.parse({post_id: 1, limit: 101}), z.ZodError);
    assert.throws(() => getPostCommentsSchema.parse({post_id: 1, limit: 0}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getPostCommentsSchema.parse({post_id: 1, offset: 10}),
      (error) => /Unrecognized key/.test(error.message) && /\boffset\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getPostCommentsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('getPostCommentsHandler', () => {
  test('forwards the limit as a query parameter', async () => {
    await getPostCommentsHandler({post_id: 167712345, limit: 10});

    const url = new URL(msw.requests.at(-1).url);

    assert.equal(url.pathname, '/api/v1/post/167712345/comments');
    assert.equal(url.searchParams.get('limit'), '10');
  });

  test('summarizes each comment with its author and thread position', async () => {
    const result = await getPostCommentsHandler({post_id: 167712345});

    assert.equal(result.returned, 3);

    const [root, reply, nested] = result.comments;

    assert.equal(root.author, 'Top Level');
    assert.equal(root.parent_comment_id, null);
    assert.equal(root.depth, 0);
    assert.equal(root.reply_count, 2);

    assert.equal(reply.parent_comment_id, 309007328);
    assert.equal(reply.depth, 1);
    assert.equal(reply.attachment_count, 1);

    // The nested reply's parent is the reply, not the thread root — the assertion that catches
    // reading ancestor_path from the wrong end.
    assert.equal(nested.parent_comment_id, 309403526);
    assert.equal(nested.depth, 2);
  });

  // A separate array in the response. Dropping it silently would turn "someone commented and it was
  // withheld" into "nobody commented".
  test('counts the automod-hidden comments separately instead of mixing them in', async () => {
    const result = await getPostCommentsHandler({post_id: 167712345});

    assert.equal(result.automod_hidden_count, 1);
    assert.ok(!result.comments.some((comment) => comment.id === 999));
  });

  test('survives a post with no comments', async () => {
    msw.server.use(msw.postCommentsHandler(() => HttpResponse.json({comments: []}, {status: 200})));

    const result = await getPostCommentsHandler({post_id: 1});

    assert.equal(result.returned, 0);
    assert.equal(result.automod_hidden_count, 0);
    assert.deepEqual(result.comments, []);
  });

  test('does not leak the ProseMirror body', async () => {
    const result = await getPostCommentsHandler({post_id: 167712345});

    assert.ok(POST_COMMENTS_RESPONSE.comments[0].body_json, 'the fixture must carry one to drop');
    assert.ok(!('body_json' in result.comments[0]));
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.postCommentsHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => getPostCommentsHandler({post_id: 1}), /SubstackAPIException: 404/);
  });
});
