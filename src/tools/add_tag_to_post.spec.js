import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {addTagToPostHandler, addTagToPostSchema} from './add_tag_to_post.js';
import {createMswServer, POST_TAG_ASSOCIATIONS_RESPONSE} from '../../test/helpers/msw-server.js';
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

const UNTAGGED = () => msw.postTagAssociationsHandler(() => HttpResponse.json([], {status: 200}));

describe('addTagToPostSchema', () => {
  test('requires a post_id and a tag_name', () => {
    assert.throws(() => addTagToPostSchema.parse({post_id: 1}), z.ZodError);
    assert.throws(() => addTagToPostSchema.parse({tag_name: 'x'}), z.ZodError);
  });

  test('rejects an empty tag name', () => {
    assert.throws(() => addTagToPostSchema.parse({post_id: 1, tag_name: ''}), z.ZodError);
  });

  test('defaults create_if_missing to true', () => {
    assert.deepEqual(addTagToPostSchema.parse({post_id: 1, tag_name: 'x'}), {
      post_id: 1,
      tag_name: 'x',
      create_if_missing: true,
    });
  });

  // The ids are UUIDs, so a caller cannot reasonably hold one. Offering `tag_id` would invite a
  // model to invent one.
  test('rejects a tag_id — this tool takes names', () => {
    assert.throws(
      () => addTagToPostSchema.parse({post_id: 1, tag_id: 'b0f9ee7d-c995-4d18-9b2f-2bcf261a1a63'}),
      (error) => /Unrecognized key/.test(error.message) && /\btag_id\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(addTagToPostSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('addTagToPostHandler', () => {
  test('matches an existing tag by name and attaches it by UUID', async () => {
    msw.server.use(UNTAGGED());

    const result = await addTagToPostHandler({post_id: 167712345, tag_name: 'Automation'});

    assert.equal(result.status, 'tagged');
    assert.equal(result.tag.id, '58e5c27e-b4fd-4d0b-b461-be5cd94c84bf');
    assert.equal(result.tag_created, false);

    const attach = msw.requests.find((request) => request.method === 'POST');
    assert.match(
      new URL(attach.url).pathname,
      /\/api\/v1\/post\/167712345\/tag\/58e5c27e-b4fd-4d0b-b461-be5cd94c84bf$/
    );
  });

  test('matches case-insensitively, so a model need not reproduce the exact casing', async () => {
    msw.server.use(UNTAGGED());

    const result = await addTagToPostHandler({post_id: 1, tag_name: 'automation'});

    assert.equal(result.tag_created, false);
    assert.equal(result.tag.name, 'Automation');
  });

  test('creates the tag when none matches', async () => {
    msw.server.use(UNTAGGED());

    const result = await addTagToPostHandler({post_id: 1, tag_name: 'brand new'});

    assert.equal(result.tag_created, true);
    assert.equal(result.tag.id, 'aaaaaaaa-0000-0000-0000-000000000000');

    const created = msw.requests.find(
      (request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/publication/post-tag')
    );
    assert.deepEqual(created.body, {name: 'brand new'});
  });

  test('refuses to invent a tag when create_if_missing is false', async () => {
    await assert.rejects(
      () => addTagToPostHandler({post_id: 1, tag_name: 'nope', create_if_missing: false}),
      (error) => /No tag named "nope"/.test(error.message) && /list_publication_tags/.test(error.message)
    );

    assert.equal(
      msw.requests.filter((request) => request.method === 'POST').length,
      0,
      'nothing should be created or attached'
    );
  });

  // Re-attaching answers a bare 400 that names neither the post nor the tag. Checking first turns
  // that into an accurate answer rather than an error that reads as a malformed request.
  test('reports already_tagged instead of letting the API 400', async () => {
    const result = await addTagToPostHandler({post_id: 167712345, tag_name: 'Automation'});

    assert.equal(result.status, 'already_tagged');
    assert.equal(result.tag.name, 'Automation');
    assert.deepEqual(
      msw.requests.filter((request) => request.method === 'POST'),
      [],
      'the attach must not be attempted'
    );
  });

  test('still attaches when the post carries a different tag', async () => {
    msw.server.use(
      msw.postTagAssociationsHandler(() =>
        HttpResponse.json(
          [{...POST_TAG_ASSOCIATIONS_RESPONSE[0], post_tag_id: 'b0f9ee7d-c995-4d18-9b2f-2bcf261a1a63'}],
          {status: 200}
        )
      )
    );

    const result = await addTagToPostHandler({post_id: 167712345, tag_name: 'Automation'});

    assert.equal(result.status, 'tagged');
  });

  test('propagates a failing attach as an error', async () => {
    msw.server.use(UNTAGGED(), msw.addTagToPostHandler(() => HttpResponse.json({}, {status: 400})));

    await assert.rejects(
      () => addTagToPostHandler({post_id: 1, tag_name: 'Automation'}),
      /SubstackAPIException: 400/
    );
  });
});
