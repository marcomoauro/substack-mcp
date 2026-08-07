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
  test('requires a comment_id and defaults the tab', () => {
    assert.throws(() => restackItemSchema.parse({}), z.ZodError);
    assert.deepEqual(restackItemSchema.parse({comment_id: 2}), {comment_id: 2, tab_id: 'for-you'});
  });

  // Measured: `{postId, tabId}` answers 404 "Post da Restack non trovato" for a published post on the
  // caller's own publication. Offering the parameter would produce a 404 that reads as a missing post.
  test('rejects post_id — restacking a post is not supported', () => {
    assert.throws(
      () => restackItemSchema.parse({post_id: 1}),
      (error) => /Unrecognized key/.test(error.message) && /\bpost_id\b/.test(error.message)
    );
  });

  test('publishes a closed schema with a description for every field', () => {
    const json = z.toJSONSchema(restackItemSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('restackItemHandler', () => {
  // The body keys are camelCase, unlike almost everything else this server sends. Confirmed by
  // elimination: snake_case answers 400 "Devi fornire postId o commentId".
  test('posts camelCase keys to the restack endpoint', async () => {
    await restackItemHandler({comment_id: 306029118});

    const request = msw.requests.at(-1);

    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/v1/restack/feed');
    assert.deepEqual(request.body, {commentId: 306029118, tabId: 'for-you'});
  });

  test('forwards a chosen tab', async () => {
    await restackItemHandler({comment_id: 1, tab_id: 'subscribed'});

    assert.deepEqual(msw.requests.at(-1).body, {commentId: 1, tabId: 'subscribed'});
  });

  test('reports the restack and that it cannot be undone here', async () => {
    const result = await restackItemHandler({comment_id: 306029118});

    assert.equal(result.status, 'restacked');
    assert.equal(result.comment_id, 306029118);
    assert.equal(result.restack_id, 'restack-1');
    assert.match(result.note, /cannot be undone/);
  });

  // A restack is public and has no id of its own, so nothing here can remove it. The log is the only
  // record that it happened.
  test('logs the intent before the request', async () => {
    const logs = await captureLogs(() => restackItemHandler({comment_id: 306029118}));

    const line = logs.find((entry) => entry.msg === 'restack_item.restacking');

    assert.ok(line, 'restack_item.restacking should be logged');
    assert.equal(line.comment_id, 306029118);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.restackHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(() => restackItemHandler({comment_id: 1}), /SubstackAPIException: 403/);
  });
});
