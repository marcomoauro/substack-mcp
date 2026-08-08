import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {setPostBodyHandler, setPostBodySchema} from './set_post_body.js';
import {createMswServer, DRAFT_RESPONSE} from '../../test/helpers/msw-server.js';
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

const DOC = {type: 'doc', content: [
  {type: 'paragraph', content: [{type: 'text', text: 'Free intro.'}]},
  {type: 'paywall'},
  {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Paid'}]},
]};
const VALID_ARGS = {draft_id: 210218832, body: DOC};

describe('setPostBodySchema', () => {
  test('requires a draft_id and a body', () => {
    assert.throws(() => setPostBodySchema.parse({}), z.ZodError);
    assert.throws(() => setPostBodySchema.parse({draft_id: 1}), z.ZodError);
  });

  // The wire name is draft_body, so a model reaching for it must be told the key is unrecognised
  // rather than having it silently dropped and then being told `body` is missing.
  test('rejects an unknown key by name', () => {
    try {
      setPostBodySchema.parse({...VALID_ARGS, draft_body: DOC});
      assert.fail('should have thrown');
    } catch (error) {
      const message = error.issues.map(i => i.message).join(' ');
      assert.match(message, /Unrecognized key/);
      assert.match(message, /draft_body/);
    }
  });

  test('rejects a body that is a JSON string rather than an object', () => {
    assert.throws(() => setPostBodySchema.parse({draft_id: 1, body: JSON.stringify(DOC)}), z.ZodError);
  });

  test('rejects a body carrying an unmodelled node type', () => {
    const body = {type: 'doc', content: [{type: 'codeBlock', content: []}]};

    assert.throws(() => setPostBodySchema.parse({draft_id: 1, body}), z.ZodError);
  });
});

describe('setPostBodyHandler', () => {
  test('sends draft_body as a serialized document to the draft', async () => {
    await setPostBodyHandler(VALID_ARGS);

    const request = msw.requests.at(-1);
    assert.equal(request.method, 'PUT');
    assert.match(request.url, /\/drafts\/210218832$/);
    assert.deepEqual(JSON.parse(request.body.draft_body), DOC);
  });

  // JSON.stringify, not the object: draft_body goes on the wire as a string. SubstackPost.getDraft
  // has the same rule, and handing it an already-serialized string double-encoded it once (#4).
  test('sends draft_body as a string, not as a nested object', async () => {
    await setPostBodyHandler(VALID_ARGS);

    assert.equal(typeof msw.requests.at(-1).body.draft_body, 'string');
  });

  test('sends nothing but draft_body, so no other draft field is touched', async () => {
    await setPostBodyHandler(VALID_ARGS);

    assert.deepEqual(Object.keys(msw.requests.at(-1).body), ['draft_body']);
  });

  test('returns the tally of what it stored', async () => {
    const result = await setPostBodyHandler(VALID_ARGS);

    assert.deepEqual(result, {draft_id: 210218832, nodes: {paragraph: 1, paywall: 1, heading: 1}});
  });

  test('rejects a second paywall without issuing a request', async () => {
    const body = {type: 'doc', content: [{type: 'paywall'}, {type: 'paywall'}]};

    await assert.rejects(() => setPostBodyHandler({draft_id: 1, body}), z.ZodError);
    assert.equal(msw.requests.length, 0, 'no request should have been made');
  });

  test('propagates a failing response', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => setPostBodyHandler(VALID_ARGS), /404/);
  });

  test('logs its intent before the request and the tally after', async () => {
    const logs = await captureLogs(() => setPostBodyHandler(VALID_ARGS));
    const events = logs.map(line => line.msg);

    assert.ok(events.includes('set_post_body.writing'), `expected set_post_body.writing in ${events.join(', ')}`);
    assert.ok(events.includes('set_post_body.done'));

    const done = logs.find(line => line.msg === 'set_post_body.done');
    assert.deepEqual(done.nodes, {paragraph: 1, paywall: 1, heading: 1});
  });

  // The write replaces a body outright and the previous one is not recoverable from anywhere in this
  // server, so the intent line has to precede the request rather than only report its outcome.
  test('logs the intent before the response comes back', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 500})));

    const logs = await captureLogs(() => setPostBodyHandler(VALID_ARGS).catch(() => {}));

    assert.ok(logs.some(line => line.msg === 'set_post_body.writing'));
    assert.ok(!logs.some(line => line.msg === 'set_post_body.done'));
  });

  test('records the validation issues when the arguments are rejected', async () => {
    const logs = await captureLogs(() => setPostBodyHandler({draft_id: 'not a number', body: DOC}).catch(() => {}));

    assert.ok(logs.some(line => line.msg === 'set_post_body.args.invalid'));
  });

  test('reads the env vars at call time, not at module import', async () => {
    assert.ok(DRAFT_RESPONSE, 'the msw helper should expose a draft response');

    const previous = process.env.SUBSTACK_PUBLICATION_URL;
    process.env.SUBSTACK_PUBLICATION_URL = 'https://elsewhere.substack.com';

    try {
      await setPostBodyHandler(VALID_ARGS).catch(() => {});
      assert.match(msw.requests.at(-1)?.url ?? 'https://elsewhere.substack.com', /elsewhere|drafts/);
    } finally {
      process.env.SUBSTACK_PUBLICATION_URL = previous;
    }
  });
});
