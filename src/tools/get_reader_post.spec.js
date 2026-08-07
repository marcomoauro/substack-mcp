import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getReaderPostHandler, getReaderPostSchema} from './get_reader_post.js';
import {createMswServer, POST_BY_ID_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('getReaderPostSchema', () => {
  test('requires a post_id and includes the body by default', () => {
    assert.throws(() => getReaderPostSchema.parse({}), z.ZodError);
    assert.deepEqual(getReaderPostSchema.parse({post_id: 1}), {post_id: 1, include_body: true});
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getReaderPostSchema.parse({post_id: 1, format: 'markdown'}),
      (error) => /Unrecognized key/.test(error.message) && /\bformat\b/.test(error.message)
    );
  });

  test('publishes a description for every field', () => {
    const json = z.toJSONSchema(getReaderPostSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    for (const [name, property] of Object.entries(json.properties)) {
      assert.ok(property.description, `${name} has no description`);
    }
  });
});

describe('getReaderPostHandler', () => {
  test('reads substack.com by post id', async () => {
    await getReaderPostHandler({post_id: 204305990});

    const url = new URL(msw.requests.at(-1).url);

    assert.equal(url.origin, 'https://substack.com');
    assert.equal(url.pathname, '/api/v1/posts/by-id/204305990');
  });

  test('returns the post with its body and its publication', async () => {
    const result = await getReaderPostHandler({post_id: 204305990});

    assert.equal(result.title, 'A Post From Someone Else');
    assert.equal(result.author, 'Alex Pozzi');
    assert.equal(result.publication, 'Alex’s Publication');
    assert.equal(result.body_html, '<p>The body of someone else’s post</p>');
    assert.equal(result.wordcount, 900);
  });

  test('omits the body when asked to', async () => {
    const result = await getReaderPostHandler({post_id: 204305990, include_body: false});

    assert.ok(!('body_html' in result));
    // Still present: the metadata is the point of the call in this mode.
    assert.equal(result.title, 'A Post From Someone Else');
    assert.equal(result.preview_text, 'The body of someone…');
  });

  // A paywalled post answers with a teaser and no body. Reporting that beats returning a null body
  // that reads as an empty post.
  test('flags a body withheld behind a paywall', async () => {
    msw.server.use(
      msw.postByIdHandler(() =>
        HttpResponse.json(
          {...POST_BY_ID_RESPONSE, post: {...POST_BY_ID_RESPONSE.post, body_html: null}},
          {status: 200}
        )
      )
    );

    const result = await getReaderPostHandler({post_id: 1});

    assert.equal(result.body_truncated, true);
    assert.equal(result.preview_text, 'The body of someone…');
  });

  test('does not claim truncation on a post that came back whole', async () => {
    assert.equal((await getReaderPostHandler({post_id: 204305990})).body_truncated, false);
  });

  // A 200 carrying no post would otherwise produce an object of nulls that reads as a real post.
  test('refuses a response with no post rather than returning nulls', async () => {
    msw.server.use(msw.postByIdHandler(() => HttpResponse.json({publication: {id: 1}}, {status: 200})));

    await assert.rejects(
      () => getReaderPostHandler({post_id: 42}),
      /Substack post 42 was not found/
    );
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.postByIdHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => getReaderPostHandler({post_id: 1}), /SubstackAPIException: 404/);
  });
});
