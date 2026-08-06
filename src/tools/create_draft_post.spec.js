import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {createDraftPostHandler, createDraftPostSchema} from './create_draft_post.js';
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

const VALID_ARGS = {title: 'My title', subtitle: 'My subtitle', body: 'The body'};

describe('createDraftPostSchema', () => {
  test('accepts title, subtitle and body as strings', () => {
    assert.deepEqual(createDraftPostSchema.parse(VALID_ARGS), VALID_ARGS);
  });

  test('requires all three fields', () => {
    assert.throws(() => createDraftPostSchema.parse({title: 'title only'}), z.ZodError);
  });
});

describe('createDraftPostHandler — success', () => {
  test('returns OK', async () => {
    assert.equal(await createDraftPostHandler(VALID_ARGS), 'OK');
  });

  test('sends exactly one request to the drafts endpoint', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].url, DRAFTS_URL);
  });

  test('maps the arguments onto the draft fields', async () => {
    await createDraftPostHandler(VALID_ARGS);

    const {body} = msw.requests[0];
    assert.equal(body.draft_title, 'My title');
    assert.equal(body.draft_subtitle, 'My subtitle');
    assert.deepEqual(body.draft_bylines, [{id: 12345, is_guest: false}]);
    assert.equal(body.audience, 'everyone');
    assert.equal(body.write_comment_permissions, 'everyone');
    assert.equal(body.section_chosen, true);
    assert.equal(body.draft_section_id, null);
  });

  // Before the double-encoding fix the handler passed the raw string to setBody, and
  // getDraft applied JSON.stringify to it: draft_body arrived as '"The body"', which the
  // Substack editor cannot parse as a document. parseBody now builds the document before
  // setBody, so draft_body is the serialization of a valid doc.
  test('draft_body arrives as a serialized ProseMirror document', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.deepEqual(JSON.parse(msw.requests[0].body.draft_body), {
      type: 'doc',
      content: [{type: 'paragraph', content: [{type: 'text', text: 'The body'}]}],
    });
  });

  test('authenticates with the token taken from the env vars', async () => {
    await createDraftPostHandler(VALID_ARGS);

    assert.equal(
      msw.requests[0].headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });

  test('reads the env vars at call time, not at module import', async () => {
    const previous = process.env.SUBSTACK_USER_ID;
    process.env.SUBSTACK_USER_ID = '99999';

    try {
      await createDraftPostHandler(VALID_ARGS);
      assert.deepEqual(msw.requests[0].body.draft_bylines, [{id: 99999, is_guest: false}]);
    } finally {
      process.env.SUBSTACK_USER_ID = previous;
    }
  });
});

describe('createDraftPostHandler — body conversion', () => {
  // parseBody is not exported, so it is exercised through the handler by observing the
  // draft_body actually sent.
  async function sendAndDecode(body) {
    await createDraftPostHandler({...VALID_ARGS, body});
    return JSON.parse(msw.requests.at(-1).body.draft_body);
  }

  function paragraphTexts(doc) {
    return doc.content.map((paragraph) => paragraph.content[0].text);
  }

  test('plain text becomes a single paragraph', async () => {
    const doc = await sendAndDecode('A single line');

    assert.deepEqual(doc, {
      type: 'doc',
      content: [{type: 'paragraph', content: [{type: 'text', text: 'A single line'}]}],
    });
  });

  test('paragraphs separated by a blank line become distinct nodes', async () => {
    const doc = await sendAndDecode('First paragraph\n\nSecond paragraph');

    assert.deepEqual(paragraphTexts(doc), ['First paragraph', 'Second paragraph']);
  });

  // The split is on /\n+/, so every line break opens a paragraph: text with single
  // newlines does not stay one paragraph. The PR description says "blank lines", but this
  // is the actual behaviour.
  test('a single newline also starts a new paragraph', async () => {
    const doc = await sendAndDecode('Line one\nLine two');

    assert.deepEqual(paragraphTexts(doc), ['Line one', 'Line two']);
  });

  test('surplus blank lines do not produce empty paragraphs', async () => {
    const doc = await sendAndDecode('\n\nFirst\n\n\n\nSecond\n\n');

    assert.deepEqual(paragraphTexts(doc), ['First', 'Second']);
  });

  test('a ProseMirror document given as JSON is passed through untouched', async () => {
    const doc = {
      type: 'doc',
      content: [
        {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Heading'}]},
        {type: 'paragraph', content: [{type: 'text', text: 'Body'}]},
      ],
    };

    assert.deepEqual(await sendAndDecode(JSON.stringify(doc)), doc);
  });

  test('valid JSON that is not a document is treated as text', async () => {
    const doc = await sendAndDecode('{"a":1}');

    assert.deepEqual(paragraphTexts(doc), ['{"a":1}']);
  });

  test('malformed JSON is treated as text', async () => {
    const doc = await sendAndDecode('{not valid');

    assert.deepEqual(paragraphTexts(doc), ['{not valid']);
  });

  test('an empty string produces a document with no content', async () => {
    assert.deepEqual(await sendAndDecode(''), {type: 'doc', content: []});
  });
});

describe('createDraftPostHandler — errors', () => {
  test('throws ZodError on invalid arguments without issuing any request', async () => {
    await assert.rejects(
      () => createDraftPostHandler({title: 'title only'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('rejects a body that is not a string', async () => {
    await assert.rejects(
      () => createDraftPostHandler({...VALID_ARGS, body: {type: 'doc'}}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  test('propagates Substack API errors', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const error = await createDraftPostHandler(VALID_ARGS).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 500\b/);
  });
});
