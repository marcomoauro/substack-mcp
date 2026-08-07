import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getCommentThreadHandler, getCommentThreadSchema} from './get_comment_thread.js';
import {createMswServer} from '../../test/helpers/msw-server.js';
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

describe('getCommentThreadSchema', () => {
  test('requires a comment_id and fetches replies by default', () => {
    assert.throws(() => getCommentThreadSchema.parse({}), z.ZodError);
    assert.deepEqual(getCommentThreadSchema.parse({comment_id: 1}), {
      comment_id: 1,
      include_replies: true,
    });
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getCommentThreadSchema.parse({comment_id: 1, note_id: 2}),
      (error) => /Unrecognized key/.test(error.message) && /\bnote_id\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getCommentThreadSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('getCommentThreadHandler', () => {
  test('reads both the comment and its replies', async () => {
    await getCommentThreadHandler({comment_id: 309007328});

    const paths = msw.requests.map((request) => new URL(request.url).pathname);

    assert.ok(paths.includes('/api/v1/reader/comment/309007328'));
    assert.ok(paths.includes('/api/v1/reader/comment/309007328/replies'));
  });

  // The detail endpoint wraps its payload in `item`; the replies endpoint does not. Reading the
  // wrong level yields a comment with no id.
  test('unwraps the comment from the item envelope', async () => {
    const result = await getCommentThreadHandler({comment_id: 309007328});

    assert.equal(result.comment.id, 309007328);
    assert.equal(result.comment.author, 'Thread Root');
    assert.equal(result.comment.depth, 0);
  });

  test('returns each branch with its descendants, thread positions resolved', async () => {
    const result = await getCommentThreadHandler({comment_id: 309007328});

    assert.equal(result.branch_count, 1);
    assert.equal(result.replies_returned, 2);

    const [branch] = result.branches;

    assert.equal(branch.reply.id, 309403526);
    assert.equal(branch.reply.parent_comment_id, 309007328);
    assert.equal(branch.reply.depth, 1);

    // The nested reply answers the reply, not the root.
    assert.equal(branch.descendants[0].parent_comment_id, 309403526);
    assert.equal(branch.descendants[0].depth, 2);
  });

  test('skips the replies request when told to', async () => {
    const result = await getCommentThreadHandler({comment_id: 309007328, include_replies: false});

    assert.equal(msw.requests.length, 1);
    assert.ok(!('branches' in result));
    assert.equal(result.comment.id, 309007328);
  });

  test('refuses a response carrying no comment rather than returning nulls', async () => {
    msw.server.use(msw.readerCommentHandler(() => HttpResponse.json({item: {}}, {status: 200})));

    await assert.rejects(
      () => getCommentThreadHandler({comment_id: 42}),
      /Substack comment 42 was not found/
    );
  });

  test('survives a comment with no replies', async () => {
    msw.server.use(
      msw.readerCommentRepliesHandler(() =>
        HttpResponse.json({commentBranches: [], moreBranches: false, nextCursor: null}, {status: 200})
      )
    );

    const result = await getCommentThreadHandler({comment_id: 309007328});

    assert.equal(result.replies_returned, 0);
    assert.deepEqual(result.branches, []);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.readerCommentHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => getCommentThreadHandler({comment_id: 1}), /SubstackAPIException: 404/);
  });
});
