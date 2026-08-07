import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {commentOnPostHandler, commentOnPostSchema} from './comment_on_post.js';
import {createMswServer} from '../../test/helpers/msw-server.js';
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

describe('commentOnPostSchema', () => {
  test('requires a post_id and a body', () => {
    assert.throws(() => commentOnPostSchema.parse({post_id: 1}), z.ZodError);
    assert.throws(() => commentOnPostSchema.parse({body: 'x'}), z.ZodError);
  });

  test('rejects an empty body', () => {
    assert.throws(() => commentOnPostSchema.parse({post_id: 1, body: ''}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => commentOnPostSchema.parse({post_id: 1, body: 'x', text: 'y'}),
      (error) => /Unrecognized key/.test(error.message) && /\btext\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(commentOnPostSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('commentOnPostHandler', () => {
  test('posts the body to the comment endpoint', async () => {
    await commentOnPostHandler({post_id: 167712345, body: 'Thanks for reading'});

    const request = msw.requests.at(-1);

    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/v1/post/167712345/comment');
    assert.deepEqual(request.body, {body: 'Thanks for reading'});
  });

  test('returns the created comment, summarized', async () => {
    const result = await commentOnPostHandler({post_id: 167712345, body: 'x'});

    assert.equal(result.status, 'posted');
    assert.equal(result.comment.id, 309007328);
    assert.equal(result.comment.author, 'Top Level');
  });

  // This publishes under the user's name and the server offers no way to delete it, so the log is
  // the only record of what was said. Renaming the line is the cheapest way to break this test.
  test('logs the full text before posting', async () => {
    const logs = await captureLogs(() =>
      commentOnPostHandler({post_id: 167712345, body: 'A public statement'})
    );

    const line = logs.find((entry) => entry.msg === 'comment_on_post.posting');

    assert.ok(line, 'comment_on_post.posting should be logged');
    assert.equal(line.body, 'A public statement');
    assert.equal(line.post_id, 167712345);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.createCommentHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(
      () => commentOnPostHandler({post_id: 1, body: 'x'}),
      /SubstackAPIException: 403/
    );
  });
});
