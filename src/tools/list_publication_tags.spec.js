import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {listPublicationTagsHandler, listPublicationTagsSchema} from './list_publication_tags.js';
import {createMswServer, POST_TAG_URL} from '../../test/helpers/msw-server.js';
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

describe('listPublicationTagsSchema', () => {
  test('takes no required argument and includes hidden tags by default', () => {
    assert.deepEqual(listPublicationTagsSchema.parse({}), {include_hidden: true});
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => listPublicationTagsSchema.parse({hidden: false}),
      (error) => /Unrecognized key/.test(error.message) && /\bhidden\b/.test(error.message)
    );
  });

  test('publishes a description for include_hidden', () => {
    const json = z.toJSONSchema(listPublicationTagsSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.ok(json.properties.include_hidden.description);
  });
});

describe('listPublicationTagsHandler', () => {
  // Not `/post_tags`, which answers 404 on the live API. This assertion is the record of that.
  test('reads /publication/post-tag', async () => {
    await listPublicationTagsHandler({});

    assert.equal(msw.requests.at(-1).url, POST_TAG_URL);
  });

  test('returns each tag with its UUID id, name and slug', async () => {
    const result = await listPublicationTagsHandler({});

    assert.equal(result.total, 3);
    assert.equal(result.returned, 3);
    assert.deepEqual(result.tags[0], {
      id: 'b0f9ee7d-c995-4d18-9b2f-2bcf261a1a63',
      name: 'alarms',
      slug: 'alarms',
      hidden: false,
    });
    // A UUID, not an integer: a tool typed z.number() would have failed on contact with this API.
    assert.equal(typeof result.tags[0].id, 'string');
  });

  test('filters out hidden tags on request, and still reports the true total', async () => {
    const result = await listPublicationTagsHandler({include_hidden: false});

    assert.equal(result.total, 3);
    assert.equal(result.returned, 2);
    assert.ok(!result.tags.some((tag) => tag.hidden));
  });

  test('survives a publication with no tags', async () => {
    msw.server.use(msw.postTagsHandler(() => HttpResponse.json([], {status: 200})));

    const result = await listPublicationTagsHandler({});

    assert.deepEqual(result, {total: 0, returned: 0, tags: []});
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.postTagsHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(() => listPublicationTagsHandler({}), /SubstackAPIException: 403/);
  });
});
