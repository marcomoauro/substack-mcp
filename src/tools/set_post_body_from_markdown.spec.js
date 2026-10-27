import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {setPostBodyFromMarkdownHandler, setPostBodyFromMarkdownSchema} from './set_post_body_from_markdown.js';
import {MarkdownConversionError} from '../api/substack/markdown.js';
import {createMswServer} from '../../test/helpers/msw-server.js';
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

const MARKDOWN = '## Intro\n\nHello **there**.\n\n- one\n- two';
const VALID_ARGS = {draft_id: 210218832, markdown: MARKDOWN};
const EXPECTED_DOC = {type: 'doc', content: [
  {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Intro'}]},
  {type: 'paragraph', content: [{type: 'text', text: 'Hello '}, {type: 'text', text: 'there', marks: [{type: 'strong'}]}, {type: 'text', text: '.'}]},
  {type: 'bullet_list', content: [
    {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'one'}]}]},
    {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'two'}]}]},
  ]},
]};

describe('setPostBodyFromMarkdownSchema', () => {
  test('requires a draft_id and a markdown string', () => {
    assert.throws(() => setPostBodyFromMarkdownSchema.parse({}), z.ZodError);
    assert.throws(() => setPostBodyFromMarkdownSchema.parse({draft_id: 1}), z.ZodError);
    assert.throws(() => setPostBodyFromMarkdownSchema.parse({draft_id: 1, markdown: {type: 'doc'}}), z.ZodError);
  });

  test('reports an unknown key instead of stripping it', () => {
    assert.throws(
      () => setPostBodyFromMarkdownSchema.parse({...VALID_ARGS, body: 'x'}),
      (error) => error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'unrecognized_keys'),
    );
  });
});

describe('setPostBodyFromMarkdownHandler', () => {
  test('sends the converted document as draft_body, serialized, and nothing else', async () => {
    await setPostBodyFromMarkdownHandler(VALID_ARGS);

    const request = msw.requests.at(-1);
    assert.equal(request.method, 'PUT');
    assert.match(request.url, /\/drafts\/210218832$/);
    assert.deepEqual(Object.keys(request.body), ['draft_body']);
    assert.equal(typeof request.body.draft_body, 'string');
    assert.deepEqual(JSON.parse(request.body.draft_body), EXPECTED_DOC);
  });

  test('returns the tally of what it stored', async () => {
    const result = await setPostBodyFromMarkdownHandler(VALID_ARGS);

    assert.deepEqual(result, {draft_id: 210218832, nodes: {heading: 1, paragraph: 3, bullet_list: 1, list_item: 2}});
  });

  test('writes nothing when the Markdown cannot be converted faithfully', async () => {
    await assert.rejects(
      () => setPostBodyFromMarkdownHandler({draft_id: 1, markdown: 'ok\n\n[Subscribe](%%checkout_url%%)'}),
      MarkdownConversionError,
    );
    assert.equal(msw.requests.length, 0, 'no request should have been made');
  });

  test('propagates a failing response', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => setPostBodyFromMarkdownHandler(VALID_ARGS), /404/);
  });

  test('logs its arguments, its intent before the request and the tally after', async () => {
    const logs = await captureLogs(() => setPostBodyFromMarkdownHandler(VALID_ARGS));
    const byMsg = (msg) => logs.find((line) => line.msg === msg);

    assert.deepEqual(byMsg('set_post_body_from_markdown.start')?.args, VALID_ARGS);
    assert.ok(byMsg('set_post_body_from_markdown.writing'), `expected .writing in ${logs.map((l) => l.msg).join(', ')}`);
    assert.deepEqual(byMsg('set_post_body_from_markdown.done')?.nodes, {heading: 1, paragraph: 3, bullet_list: 1, list_item: 2});
  });

  test('logs the intent before the response comes back', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 500})));

    const logs = await captureLogs(() => setPostBodyFromMarkdownHandler(VALID_ARGS).catch(() => {}));

    assert.ok(logs.some((line) => line.msg === 'set_post_body_from_markdown.writing'));
    assert.ok(!logs.some((line) => line.msg === 'set_post_body_from_markdown.done'));
  });

  test('records the problems when the Markdown is refused', async () => {
    const logs = await captureLogs(() =>
      setPostBodyFromMarkdownHandler({draft_id: 1, markdown: '<div>x</div>'}).catch(() => {}));
    const line = logs.find((l) => l.msg === 'set_post_body_from_markdown.unconvertible');

    assert.ok(line, `expected .unconvertible in ${logs.map((l) => l.msg).join(', ')}`);
    assert.equal(line.problems.length, 1);
  });

  test('records the validation issues when the arguments are rejected', async () => {
    const logs = await captureLogs(() =>
      setPostBodyFromMarkdownHandler({draft_id: 'x', markdown: 'a'}).catch(() => {}));

    assert.ok(logs.some((line) => line.msg === 'set_post_body_from_markdown.args.invalid'));
  });

  test('authenticates with the token taken from the env vars', async () => {
    await setPostBodyFromMarkdownHandler(VALID_ARGS);

    assert.equal(
      msw.requests.at(-1).headers.cookie,
      'substack.sid=test-session-token; connect.sid=test-session-token;'
    );
  });
});
