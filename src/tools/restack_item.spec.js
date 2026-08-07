import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {restackItemHandler, restackItemSchema} from './restack_item.js';
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

describe('restackItemSchema', () => {
  test('accepts a post id alone', () => {
    assert.deepEqual(restackItemSchema.parse({post_id: 1}), {post_id: 1, tab_id: 'for-you'});
  });

  test('accepts a comment id alone', () => {
    assert.deepEqual(restackItemSchema.parse({comment_id: 2}), {comment_id: 2, tab_id: 'for-you'});
  });

  // The API takes both keys and has no documented behaviour for receiving both, so the pair is made
  // unrepresentable rather than left to be discovered against a live account.
  test('refuses both ids at once', () => {
    assert.throws(
      () => restackItemSchema.parse({post_id: 1, comment_id: 2}),
      /Provide exactly one of post_id or comment_id/
    );
  });

  test('refuses neither', () => {
    assert.throws(
      () => restackItemSchema.parse({}),
      /Provide exactly one of post_id or comment_id/
    );
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => restackItemSchema.parse({post_id: 1, note: 'x'}),
      (error) => /Unrecognized key/.test(error.message) && /\bnote\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(restackItemSchema, {target: 'draft-7', io: 'input'});

    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('restackItemHandler', () => {
  test('posts a comment restack with camelCase keys', async () => {
    await restackItemHandler({comment_id: 306029118});

    const request = msw.requests.at(-1);

    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/v1/restack/feed');
    // The wire format is camelCase, unlike the snake_case this tool takes.
    assert.deepEqual(request.body, {commentId: 306029118, tabId: 'for-you'});
  });

  test('posts a post restack, omitting the id it was not given', async () => {
    await restackItemHandler({post_id: 204305990, tab_id: 'subscribed'});

    assert.deepEqual(msw.requests.at(-1).body, {postId: 204305990, tabId: 'subscribed'});
  });

  test('returns the restack id', async () => {
    const result = await restackItemHandler({post_id: 1});

    assert.deepEqual(result, {status: 'restacked', post_id: 1, restack_id: 'restack-1'});
  });

  // A restack is public and this server cannot undo one, so the log is the only record it happened.
  test('logs the intent before the request', async () => {
    const logs = await captureLogs(() => restackItemHandler({comment_id: 306029118}));

    const line = logs.find((entry) => entry.msg === 'restack_item.restacking');

    assert.ok(line, 'restack_item.restacking should be logged');
    assert.equal(line.comment_id, 306029118);
    assert.equal(line.post_id, null);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.restackHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(() => restackItemHandler({post_id: 1}), /SubstackAPIException: 403/);
  });
});
