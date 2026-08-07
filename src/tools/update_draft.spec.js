import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {updateDraftHandler, updateDraftSchema} from './update_draft.js';
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

describe('updateDraftSchema', () => {
  test('requires a draft_id', () => {
    assert.throws(() => updateDraftSchema.parse({draft_title: 'x'}), z.ZodError);
  });

  test('accepts an id alone — the no-field refusal is the handler’s job, not the schema’s', () => {
    assert.deepEqual(updateDraftSchema.parse({draft_id: 1}), {draft_id: 1});
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => updateDraftSchema.parse({draft_id: 1, title: 'x'}),
      (error) => /Unrecognized key/.test(error.message) && /\btitle\b/.test(error.message)
    );
  });

  test('rejects an audience outside the enum', () => {
    assert.throws(() => updateDraftSchema.parse({draft_id: 1, audience: 'premium'}), z.ZodError);
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(updateDraftSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('updateDraftHandler', () => {
  test('sends only the fields provided, as a PUT', async () => {
    await updateDraftHandler({draft_id: 167712345, draft_title: 'New title'});

    const request = msw.requests.at(-1);

    assert.equal(request.method, 'PUT');
    assert.equal(request.url, `${DRAFTS_URL}/167712345`);
    // The whole point of the partial update: an absent key must not be sent as null, which would
    // blank the field rather than leave it alone.
    assert.deepEqual(request.body, {draft_title: 'New title'});
  });

  test('forwards every provided field', async () => {
    await updateDraftHandler({
      draft_id: 1,
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_paid',
    });

    assert.deepEqual(msw.requests.at(-1).body, {
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_paid',
    });
  });

  test('refuses an update with no fields rather than sending a no-op PUT', async () => {
    await assert.rejects(
      () => updateDraftHandler({draft_id: 1}),
      /No fields to update/
    );

    assert.equal(msw.requests.length, 0, 'no request should have been made');
  });

  test('reports which fields it changed', async () => {
    const result = await updateDraftHandler({draft_id: 167712345, draft_title: 'New title'});

    assert.deepEqual(result.updated_fields, ['draft_title']);
    assert.equal(result.draft_id, 167712345);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(
      () => updateDraftHandler({draft_id: 1, draft_title: 'x'}),
      /SubstackAPIException: 404/
    );
  });
});
