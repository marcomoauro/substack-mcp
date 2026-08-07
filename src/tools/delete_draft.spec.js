import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {deleteDraftHandler, deleteDraftSchema} from './delete_draft.js';
import {createMswServer, DRAFTS_URL, DRAFT_DETAIL_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('deleteDraftSchema', () => {
  test('requires a draft_id', () => {
    assert.throws(() => deleteDraftSchema.parse({}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => deleteDraftSchema.parse({draft_id: 1, post_id: 2}),
      (error) => /Unrecognized key/.test(error.message) && /\bpost_id\b/.test(error.message)
    );
  });

  test('publishes a description for draft_id', () => {
    const json = z.toJSONSchema(deleteDraftSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.ok(json.properties.draft_id.description);
  });
});

describe('deleteDraftHandler', () => {
  test('reads the draft first, then deletes it', async () => {
    const result = await deleteDraftHandler({draft_id: 167712345});

    assert.deepEqual(
      msw.requests.map((request) => [request.method, request.url]),
      [
        ['GET', `${DRAFTS_URL}/167712345`],
        ['DELETE', `${DRAFTS_URL}/167712345`],
      ]
    );
    assert.equal(result.status, 'deleted');
    assert.equal(result.draft_id, 167712345);
  });

  // The guard is the reason this tool costs two requests instead of one. `DELETE /drafts/:id`
  // removes a published post just as readily, so without the read a mistyped id silently deletes
  // live content — break the `is_published` check and this is the test that fails.
  test('refuses a published post and never sends the DELETE', async () => {
    msw.server.use(
      msw.draftDetailHandler(() =>
        HttpResponse.json({...DRAFT_DETAIL_RESPONSE, is_published: true, draft_title: 'Live post'}, {status: 200})
      )
    );

    await assert.rejects(
      () => deleteDraftHandler({draft_id: 167712345}),
      (error) =>
        /is a published post/.test(error.message) &&
        /Live post/.test(error.message) &&
        /irreversible/.test(error.message)
    );

    assert.deepEqual(
      msw.requests.map((request) => request.method),
      ['GET'],
      'the DELETE must not be sent for a published post'
    );
  });

  test('propagates a failing delete as an error', async () => {
    msw.server.use(msw.draftDeleteHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(
      () => deleteDraftHandler({draft_id: 167712345}),
      /SubstackAPIException: 403/
    );
  });
});
