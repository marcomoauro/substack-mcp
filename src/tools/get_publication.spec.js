import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getPublicationHandler, getPublicationSchema} from './get_publication.js';
import {createMswServer, PUBLICATION_URL, PUBLICATION_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('getPublicationSchema', () => {
  test('takes no required argument and defaults to the projection', () => {
    assert.deepEqual(getPublicationSchema.parse({}), {full: false});
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getPublicationSchema.parse({verbose: true}),
      (error) => /Unrecognized key/.test(error.message) && /\bverbose\b/.test(error.message)
    );
  });

  test('publishes a description for full', () => {
    const json = z.toJSONSchema(getPublicationSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.ok(json.properties.full.description);
  });
});

describe('getPublicationHandler', () => {
  test('requests the publication endpoint', async () => {
    await getPublicationHandler({});

    assert.equal(msw.requests.at(-1).method, 'GET');
    assert.equal(msw.requests.at(-1).url, PUBLICATION_URL);
  });

  test('projects away the notification toggles and the HTML blobs', async () => {
    const result = await getPublicationHandler({});

    assert.equal(result.name, 'Test Publication');
    assert.equal(result.subdomain, 'test');
    assert.equal(result.email_from_name, 'Test Author');
    // The two fields the projection exists to drop.
    assert.ok(!('post_reaction_email_disabled' in result));
    assert.ok(!('tos_content' in result));
    assert.equal(result._meta.projected, true);
    assert.equal(result._meta.available_fields, Object.keys(PUBLICATION_RESPONSE).length);
  });

  test('returns the raw payload untouched when full is set', async () => {
    const result = await getPublicationHandler({full: true});

    assert.deepEqual(result, PUBLICATION_RESPONSE);
    assert.ok(!('_meta' in result), 'the raw payload must not be annotated');
  });

  // A projected key the API stopped sending would otherwise vanish silently, which reads as "the
  // publication has no name" rather than "the field moved".
  test('names a projected field the API did not return', async () => {
    msw.server.use(
      msw.publicationHandler(() => {
        const {name, ...withoutName} = PUBLICATION_RESPONSE;
        return HttpResponse.json(withoutName, {status: 200});
      })
    );

    const result = await getPublicationHandler({});

    assert.deepEqual(result._meta.fields_not_returned_by_api, ['name']);
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.publicationHandler(() => HttpResponse.json({}, {status: 403})));

    await assert.rejects(() => getPublicationHandler({}), /SubstackAPIException: 403/);
  });
});
