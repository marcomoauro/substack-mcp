import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {http, HttpResponse} from 'msw';
import {updateDraftHandler, updateDraftSchema} from './update_draft.js';
import {createMswServer, DRAFTS_URL, IMAGE_UPLOAD_RESPONSE} from '../../test/helpers/msw-server.js';
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

// A public address for the source host, so the SSRF guard passes without touching real DNS.
const publicLookup = async () => [{address: '93.184.216.34', family: 4}];

// A source image served by MSW, and the handler that serves it.
const SOURCE = 'https://images.example.com/cover.jpg';
const sourceHandler = ({body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), type = 'image/jpeg'} = {}) =>
  http.get(SOURCE, () => new HttpResponse(body, {status: 200, headers: {'Content-Type': type}}));

const run = (args, deps = {}) => updateDraftHandler(args, {lookup: publicLookup, ...deps});

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

  // Measured live 2026-08-08: the API accepts only_free and the editor's Audience control offers it.
  // The enum shipped without it, so a legal value was unreachable through this server.
  test('accepts only_free, which the enum used to refuse', () => {
    assert.deepEqual(
      updateDraftSchema.parse({draft_id: 1, audience: 'only_free'}),
      {draft_id: 1, audience: 'only_free'}
    );
  });

  test('accepts every measured comment permission', () => {
    for (const level of ['everyone', 'subscribers', 'only_paid', 'none']) {
      assert.deepEqual(
        updateDraftSchema.parse({draft_id: 1, write_comment_permissions: level}),
        {draft_id: 1, write_comment_permissions: level}
      );
    }
  });

  // Substack answers a bad write_comment_permissions with {"error":"Something went wrong"} — no
  // field name, no valid set. This enum is the only diagnosis a caller will ever get.
  test('rejects a comment permission outside the enum', () => {
    assert.throws(
      () => updateDraftSchema.parse({draft_id: 1, write_comment_permissions: 'bogus_level'}),
      z.ZodError
    );
  });

  test('accepts every measured comment sort', () => {
    for (const sort of ['best_first', 'most_recent_first', 'oldest_first']) {
      assert.deepEqual(
        updateDraftSchema.parse({draft_id: 1, default_comment_sort: sort}),
        {draft_id: 1, default_comment_sort: sort}
      );
    }
  });

  // These six answer 200 and change nothing — measured one PUT at a time on 2026-08-08. They stay
  // off the schema so strictObject tells the model the key does not exist, rather than letting it
  // believe it scheduled a post or set a language.
  test('rejects the fields the API silently ignores', () => {
    for (const field of [
      'postSchedules',
      'language',
      'email_from_name',
      'is_draft_hidden',
      'ai_detection_disabled',
      'free_unlock_required',
    ]) {
      assert.throws(
        () => updateDraftSchema.parse({draft_id: 1, [field]: 'x'}),
        (error) => /Unrecognized key/.test(error.message) && error.message.includes(field),
        `${field} should be rejected by name`
      );
    }
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

  test('forwards every settings field under its wire name', async () => {
    await updateDraftHandler({
      draft_id: 1,
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_free',
      write_comment_permissions: 'only_paid',
      default_comment_sort: 'most_recent_first',
      social_title: 'Social',
      description: 'Social description',
      search_engine_title: 'SEO title',
      search_engine_description: 'SEO description',
      slug: 'my-post-slug',
    });

    assert.deepEqual(msw.requests.at(-1).body, {
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_free',
      write_comment_permissions: 'only_paid',
      default_comment_sort: 'most_recent_first',
      social_title: 'Social',
      description: 'Social description',
      search_engine_title: 'SEO title',
      search_engine_description: 'SEO description',
      slug: 'my-post-slug',
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

describe('updateDraftHandler — cover_image', () => {
  const HOSTED = 'https://substack-post-media.s3.amazonaws.com/public/images/existing_1500x1000.jpeg';

  test('forwards a cover already on a Substack host without uploading it', async () => {
    await run({draft_id: 1, cover_image: HOSTED});

    assert.equal(
      msw.requests.filter((r) => r.url.endsWith('/api/v1/image')).length,
      0,
      're-hosting an asset Substack already serves would upload a duplicate'
    );
    assert.deepEqual(msw.requests.at(-1).body, {cover_image: HOSTED});
  });

  test('re-hosts an external cover, then PUTs the returned S3 url', async () => {
    msw.server.use(sourceHandler());

    await run({draft_id: 1, cover_image: SOURCE});

    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.ok(upload, 'an external url must be re-hosted: Substack server-fetches only its own bucket');
    assert.match(upload.body.image, /^data:image\/jpeg;base64,/);

    const put = msw.requests.at(-1);
    assert.equal(put.method, 'PUT');
    assert.deepEqual(put.body, {cover_image: IMAGE_UPLOAD_RESPONSE.url});
  });

  test('uploads before it PUTs, so the draft never points at an un-hosted url', async () => {
    msw.server.use(sourceHandler());

    await run({draft_id: 1, cover_image: SOURCE});

    const uploadIndex = msw.requests.findIndex((r) => r.url.endsWith('/api/v1/image'));
    const putIndex = msw.requests.findIndex((r) => r.method === 'PUT');
    assert.ok(uploadIndex < putIndex, `upload (${uploadIndex}) must precede PUT (${putIndex})`);
  });

  test('reports the url that actually landed, and where it came from', async () => {
    msw.server.use(sourceHandler());

    const result = await run({draft_id: 1, cover_image: SOURCE});

    // Without this the caller cannot learn the url its cover now points at — the same reason
    // set_post_body returns a node tally rather than 'OK'.
    assert.equal(result.cover_image, IMAGE_UPLOAD_RESPONSE.url);
    assert.equal(result.cover_image_rehosted_from, SOURCE);
  });

  test('leaves cover_image_rehosted_from null when nothing was re-hosted', async () => {
    const result = await run({draft_id: 1, cover_image: HOSTED});

    assert.equal(result.cover_image, HOSTED);
    assert.equal(result.cover_image_rehosted_from, null);
  });

  // The reason the re-host runs before the PUT: a failure here must not leave the other fields
  // written while the cover silently kept its old value.
  test('makes no PUT at all when the re-host fails', async () => {
    msw.server.use(
      http.get(SOURCE, () => new HttpResponse('nope', {status: 500, headers: {'Content-Type': 'text/plain'}}))
    );

    await assert.rejects(
      () => run({draft_id: 1, draft_title: 'T', cover_image: SOURCE}),
      /source responded 500/
    );

    assert.equal(
      msw.requests.filter((r) => r.method === 'PUT').length,
      0,
      'a failed re-host must abort before the draft is touched'
    );
  });

  test('refuses a private address for the cover source', async () => {
    await assert.rejects(
      () => updateDraftHandler(
        {draft_id: 1, cover_image: 'http://169.254.169.254/latest/meta-data/'},
        {lookup: async () => [{address: '169.254.169.254', family: 4}]}
      ),
      /private\/loopback/
    );

    assert.equal(msw.requests.filter((r) => r.method === 'PUT').length, 0);
  });
});
