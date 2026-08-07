import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getPostTagsHandler, getPostTagsSchema} from './get_post_tags.js';
import {
  createMswServer,
  POST_TAGS_RESPONSE,
  POST_TAG_ASSOCIATIONS_RESPONSE,
} from '../../test/helpers/msw-server.js';
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

describe('getPostTagsSchema', () => {
  test('requires a post_id', () => {
    assert.throws(() => getPostTagsSchema.parse({}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getPostTagsSchema.parse({post_id: 1, draft_id: 2}),
      (error) => /Unrecognized key/.test(error.message) && /\bdraft_id\b/.test(error.message)
    );
  });

  test('publishes a description for post_id', () => {
    const json = z.toJSONSchema(getPostTagsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.ok(json.properties.post_id.description);
  });
});

describe('getPostTagsHandler', () => {
  // The endpoint answers join rows with no name and no slug, so a caller handed them raw gets a list
  // of UUIDs it cannot interpret. Resolving the names is the reason this tool exists at all.
  test('resolves the UUIDs into tag names', async () => {
    const result = await getPostTagsHandler({post_id: 167712345});

    assert.equal(result.count, 1);
    assert.deepEqual(result.tags, [
      {
        post_tag_id: '58e5c27e-b4fd-4d0b-b461-be5cd94c84bf',
        name: 'Automation',
        slug: 'automation',
        hidden: false,
        association_id: 'd6131d6f-7aa6-4c62-846e-cbbeee0252d1',
      },
    ]);
  });

  test('reads both endpoints', async () => {
    await getPostTagsHandler({post_id: 167712345});

    const paths = msw.requests.map((request) => new URL(request.url).pathname);

    assert.ok(paths.includes('/api/v1/post/167712345/tag'));
    assert.ok(paths.includes('/api/v1/publication/post-tag'));
  });

  test('returns an empty list for an untagged post', async () => {
    msw.server.use(msw.postTagAssociationsHandler(() => HttpResponse.json([], {status: 200})));

    const result = await getPostTagsHandler({post_id: 1});

    assert.equal(result.count, 0);
    assert.deepEqual(result.tags, []);
    assert.ok(!('warning' in result));
  });

  // A tag on the post that is gone from the publication's list: saying so beats `name: null`, which
  // reads as a tag that has no name rather than one that could not be looked up.
  test('flags an association whose tag is no longer in the publication list', async () => {
    msw.server.use(
      msw.postTagAssociationsHandler(() =>
        HttpResponse.json(
          [{...POST_TAG_ASSOCIATIONS_RESPONSE[0], post_tag_id: 'deadbeef-0000-0000-0000-000000000000'}],
          {status: 200}
        )
      )
    );

    const result = await getPostTagsHandler({post_id: 1});

    assert.equal(result.tags[0].unresolved, true);
    assert.equal(result.tags[0].name, null);
    assert.match(result.warning, /could not be resolved/);
  });

  test('resolves a hidden tag as hidden', async () => {
    msw.server.use(
      msw.postTagAssociationsHandler(() =>
        HttpResponse.json(
          [{...POST_TAG_ASSOCIATIONS_RESPONSE[0], post_tag_id: POST_TAGS_RESPONSE[2].id}],
          {status: 200}
        )
      )
    );

    const result = await getPostTagsHandler({post_id: 1});

    assert.equal(result.tags[0].name, 'internal');
    assert.equal(result.tags[0].hidden, true);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.postTagAssociationsHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => getPostTagsHandler({post_id: 1}), /SubstackAPIException: 404/);
  });
});
