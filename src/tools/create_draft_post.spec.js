import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {createDraftPostHandler, createDraftPostSchema} from './create_draft_post.js';
import {createMswServer, DRAFTS_URL} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';
import {captureLogs} from '../../test/helpers/capture-logs.js';

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

describe('createDraftPostHandler — logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('records the arguments it received and the draft it built from them', async () => {
    const lines = await captureLogs(() => createDraftPostHandler(VALID_ARGS));

    assert.deepEqual(find(lines, 'create_draft_post.start').args, VALID_ARGS);

    const {draft} = find(lines, 'create_draft_post.draft.built');
    assert.equal(draft.draft_title, 'My title');
    assert.equal(draft.draft_subtitle, 'My subtitle');
    // The serialized document, which is the field the Substack editor actually rejects.
    assert.equal(draft.draft_body, JSON.stringify({
      type: 'doc',
      content: [{type: 'paragraph', content: [{type: 'text', text: 'The body'}]}],
    }));
  });

  // Over MCP the SDK rejects first, so this line only appears on a direct call — which is how
  // anything embedding the handler outside the server would use it.
  test('records the validation issues when the arguments are rejected', async () => {
    const lines = await captureLogs(
      () => createDraftPostHandler({title: 'title only'}).catch(() => {})
    );

    const invalid = find(lines, 'create_draft_post.args.invalid');
    assert.deepEqual(invalid.issues.map((issue) => issue.path.join('.')).sort(), ['body', 'subtitle']);
  });

  test('records how the body was interpreted', async () => {
    const lines = await captureLogs(() => createDraftPostHandler(VALID_ARGS));

    const parsed = find(lines, 'draft.body.parsed');
    assert.equal(parsed.format, 'text');
    assert.equal(parsed.nodes, 1);
  });

  test('distinguishes a document that arrived as JSON from text', async () => {
    const body = JSON.stringify({type: 'doc', content: [{type: 'paragraph'}, {type: 'paragraph'}]});
    const lines = await captureLogs(() => createDraftPostHandler({...VALID_ARGS, body}));

    const parsed = find(lines, 'draft.body.parsed');
    assert.equal(parsed.format, 'prosemirror');
    assert.equal(parsed.nodes, 2);
  });

  // The reason a model's document silently became two paragraphs of literal JSON. Nothing else
  // reports it: the draft is created either way and the tool answers OK.
  test('flags JSON that was not a document, so a silent downgrade is visible', async () => {
    const lines = await captureLogs(() => createDraftPostHandler({...VALID_ARGS, body: '{"a":1}'}));

    assert.deepEqual(find(lines, 'draft.body.json_is_not_a_document').parsed, {a: 1});
  });

  test('records the outgoing request with the session cookie redacted', async () => {
    const lines = await captureLogs(() => createDraftPostHandler(VALID_ARGS));

    const request = find(lines, 'substack.request');
    assert.equal(request.url, DRAFTS_URL);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Cookie, '***');
    assert.equal(request.body.draft_title, 'My title');

    const response = find(lines, 'substack.response');
    assert.equal(response.status, 200);
    assert.equal(typeof response.duration_ms, 'number');

    assert.equal(find(lines, 'create_draft_post.created').draft_id, 167712345);
  });

  // The thrown message carries only the status. Substack explains the refusal in the body, and
  // this is the only place it survives.
  test('records the body of a failed response, which the error message drops', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const lines = await captureLogs(
      () => createDraftPostHandler(VALID_ARGS).catch(() => {})
    );

    const failure = find(lines, 'substack.response.error');
    assert.equal(failure.status, 500);
    assert.equal(failure.body, 'boom');
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => createDraftPostHandler(VALID_ARGS), {level: 'silent'});

    assert.deepEqual(lines, []);
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
