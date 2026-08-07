import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {publishDraftHandler, publishDraftSchema} from './publish_draft.js';
import {createMswServer, DRAFTS_URL} from '../../test/helpers/msw-server.js';
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

describe('publishDraftSchema', () => {
  test('requires a draft_id', () => {
    assert.throws(() => publishDraftSchema.parse({}), z.ZodError);
  });

  // Deliberately the opposite of the API's own default. An email cannot be recalled, so omitting
  // the argument must give the recoverable half of the operation.
  test('defaults send to false, not to the API default of true', () => {
    assert.deepEqual(publishDraftSchema.parse({draft_id: 1}), {draft_id: 1, send: false});
  });

  // `share_automatically` appears zero times in the dashboard's own bundle. An unexpected parameter
  // is a 400 on several of this API's endpoints, so an invented key is not harmless.
  test('rejects share_automatically — the fork sent it, the API has no such key', () => {
    assert.throws(
      () => publishDraftSchema.parse({draft_id: 1, share_automatically: true}),
      (error) => /Unrecognized key/.test(error.message) && /share_automatically/.test(error.message)
    );
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => publishDraftSchema.parse({draft_id: 1, email: true}),
      (error) => /Unrecognized key/.test(error.message) && /\bemail\b/.test(error.message)
    );
  });

  test('publishes a description for every field, and says send is irreversible', () => {
    const json = z.toJSONSchema(publishDraftSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
    assert.match(json.properties.send.description, /cannot be unsent/);
  });
});

describe('publishDraftHandler', () => {
  test('posts to the publish endpoint with send in the body', async () => {
    await publishDraftHandler({draft_id: 167712345, send: true});

    const request = msw.requests.at(-1);

    assert.equal(request.method, 'POST');
    assert.equal(request.url, `${DRAFTS_URL}/167712345/publish`);
    assert.deepEqual(request.body, {send: true});
  });

  test('does not email when send is omitted', async () => {
    await publishDraftHandler({draft_id: 167712345});

    assert.deepEqual(msw.requests.at(-1).body, {send: false});
  });

  // The dangerous case. `should_send_email` is where the dashboard keeps this decision and it is
  // `true` by default on a real draft, so if the publish endpoint reads the draft rather than the
  // body, a `send: false` that only went in the body would mail the entire list. Both must be set,
  // and the PUT must come first — publishing before writing the intent would be too late.
  test('writes should_send_email to the draft before publishing', async () => {
    await publishDraftHandler({draft_id: 167712345, send: false});

    assert.deepEqual(
      msw.requests.map((request) => [request.method, request.body]),
      [
        ['PUT', {should_send_email: false}],
        ['POST', {send: false}],
      ]
    );
  });

  test('writes should_send_email true when the email was asked for', async () => {
    await publishDraftHandler({draft_id: 167712345, send: true});

    assert.deepEqual(msw.requests[0], {
      ...msw.requests[0],
      method: 'PUT',
      body: {should_send_email: true},
    });
  });

  // A failing PUT must abort: publishing after the intent failed to save is the exact scenario the
  // write exists to prevent.
  test('does not publish when the email intent could not be saved', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(
      () => publishDraftHandler({draft_id: 1, send: false}),
      /SubstackAPIException: 403/
    );

    assert.ok(
      !msw.requests.some((request) => request.method === 'POST'),
      'the publish must not be attempted'
    );
  });

  test('returns the published post with the url it gained', async () => {
    const result = await publishDraftHandler({draft_id: 167712345, send: true});

    assert.equal(result.status, 'published');
    assert.equal(result.post_id, 167712345);
    assert.equal(result.slug, 'test-title');
    assert.equal(result.canonical_url, 'https://test.substack.com/p/test-title');
    assert.equal(result.emailed, true);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.publishDraftHandler(() => HttpResponse.json({}, {status: 400})));

    await assert.rejects(
      () => publishDraftHandler({draft_id: 1}),
      /SubstackAPIException: 400/
    );
  });
});
