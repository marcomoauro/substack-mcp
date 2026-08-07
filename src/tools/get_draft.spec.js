import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getDraftHandler, getDraftSchema} from './get_draft.js';
import {createMswServer, DRAFT_DETAIL_RESPONSE} from '../../test/helpers/msw-server.js';
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

describe('getDraftSchema', () => {
  test('requires a draft_id', () => {
    assert.throws(() => getDraftSchema.parse({}), z.ZodError);
  });

  test('accepts an integer id', () => {
    assert.deepEqual(getDraftSchema.parse({draft_id: 167712345}), {draft_id: 167712345});
  });

  test('rejects a non-integer id', () => {
    assert.throws(() => getDraftSchema.parse({draft_id: 1.5}), z.ZodError);
    assert.throws(() => getDraftSchema.parse({draft_id: 'abc'}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getDraftSchema.parse({draft_id: 1, id: 2}),
      (error) => /Unrecognized key/.test(error.message) && /\bid\b/.test(error.message)
    );
  });

  test('publishes a description for draft_id', () => {
    const json = z.toJSONSchema(getDraftSchema, {target: 'draft-7', io: 'input'});

    assert.ok(json.properties.draft_id.description);
    assert.equal(json.additionalProperties, false);
  });
});

describe('getDraftHandler', () => {
  test('GETs the draft by id', async () => {
    const result = await getDraftHandler({draft_id: 167712345});

    assert.equal(msw.requests.length, 1);
    assert.equal(msw.requests[0].method, 'GET');
    assert.equal(new URL(msw.requests[0].url).pathname, '/api/v1/drafts/167712345');
    assert.deepEqual(result, DRAFT_DETAIL_RESPONSE);
  });

  // Unlike list_posts this returns the draft untouched: a caller asking for one specific draft
  // wants its body and its settings, and there is no second call that would fetch them.
  test('returns the draft unprojected, body included', async () => {
    const result = await getDraftHandler({draft_id: 167712345});

    assert.equal(result.draft_body, '{"type":"doc","content":[]}');
    assert.equal(result.draft_title, 'A draft');
  });

  test('propagates a 404 for a draft that does not exist', async () => {
    msw.server.use(msw.draftDetailHandler(() => new HttpResponse('nope', {status: 404})));

    const error = await getDraftHandler({draft_id: 1}).catch((e) => e);

    assert.match(error.message, /^SubstackAPIException: 404\b/);
  });

  test('throws ZodError on a malformed call without issuing any request', async () => {
    await assert.rejects(
      () => getDraftHandler({draft_id: 'abc'}),
      (error) => error instanceof z.ZodError
    );

    assert.equal(msw.requests.length, 0);
  });

  // Reached only on a direct call — over MCP the SDK answers `Input validation error` before the
  // handler runs, so this line is the only record that anything embedding the handler got it wrong.
  test('records the validation issues when the arguments are rejected', async () => {
    const lines = await captureLogs(
      () => getDraftHandler({draft_id: 'abc'}).catch(() => {})
    );

    const invalid = lines.find((entry) => entry.msg === 'get_draft.args.invalid');
    assert.ok(invalid, 'expected a get_draft.args.invalid log line');
    assert.deepEqual(invalid.issues.map((issue) => issue.path.join('.')), ['draft_id']);
  });

  test('records the id it asked for and what came back', async () => {
    const lines = await captureLogs(() => getDraftHandler({draft_id: 167712345}));
    const find = (msg) => lines.find((entry) => entry.msg === msg);

    assert.equal(find('get_draft.start').args.draft_id, 167712345);

    const done = find('get_draft.done');
    assert.ok(done, 'expected a get_draft.done log line');
    assert.equal(done.draft_id, 167712345);
    assert.equal(done.is_published, false);
  });

  test('says nothing at all when logging is silenced', async () => {
    const lines = await captureLogs(() => getDraftHandler({draft_id: 1}), {level: 'silent'});

    assert.deepEqual(lines, []);
  });
});
