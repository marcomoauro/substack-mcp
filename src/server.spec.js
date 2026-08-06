import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import {connectMcpClient} from '../test/helpers/mcp-harness.js';
import {createMswServer, DRAFTS_URL} from '../test/helpers/msw-server.js';
import {setTestEnv} from '../test/helpers/env.js';
import {captureLogs} from '../test/helpers/capture-logs.js';

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

const VALID_ARGS = {title: 'Title', subtitle: 'Subtitle', body: 'Body'};

describe('MCP server — list_tools', () => {
  test('exposes create_draft_post with its description', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();

      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'create_draft_post');
      assert.equal(tools[0].description, 'create a draft post on your Substack account.');
    } finally {
      await close();
    }
  });

  test('publishes an inputSchema with the three required fields', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const {inputSchema} = tools[0];

      assert.equal(inputSchema.type, 'object');
      assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['body', 'subtitle', 'title']);
      assert.deepEqual([...inputSchema.required].sort(), ['body', 'subtitle', 'title']);
      assert.equal(inputSchema.properties.title.type, 'string');
    } finally {
      await close();
    }
  });

  // Regression guard for the zod 3 -> 4 migration: zod-to-json-schema silently returned a
  // bare `{$schema}` for a zod 4 schema instead of throwing, which would have published a
  // parameterless tool. Asserting the descriptions — the part an LLM actually reads to fill
  // the arguments — is what makes a degraded-but-structurally-valid schema fail here.
  test('every property carries the description the LLM relies on', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const {properties} = tools[0].inputSchema;

      for (const [name, property] of Object.entries(properties)) {
        assert.equal(property.type, 'string', `${name} should be a string`);
        assert.ok(property.description, `${name} should carry a description`);
      }

      assert.match(properties.body.description, /plain text|JSON string/);
    } finally {
      await close();
    }
  });

  test('the inputSchema is a draft-07 document that closes the object', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const {inputSchema} = tools[0];

      assert.equal(inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
      // Accurate only because the schema is a strictObject: a plain z.object strips unknown
      // keys instead of rejecting them, and would publish this as an empty promise.
      assert.equal(inputSchema.additionalProperties, false);
    } finally {
      await close();
    }
  });
});

describe('MCP server — call_tool', () => {
  test('runs the tool and returns the serialized result', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.deepEqual(result.content, [{type: 'text', text: '"OK"'}]);
    } finally {
      await close();
    }
  });

  test('the call reaches the Substack API', async () => {
    const {client, close} = await connectMcpClient();

    try {
      await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.equal(msw.requests.length, 1);
      assert.equal(msw.requests[0].url, DRAFTS_URL);
      assert.equal(msw.requests[0].body.draft_title, 'Title');
    } finally {
      await close();
    }
  });

  // McpServer reports tool failures as a successful CallToolResult carrying isError: true,
  // which is the shape the MCP spec prescribes for execution errors. The three tests below
  // pinned the previous behaviour, where the hand-written handler threw and the failure
  // reached the client as a JSON-RPC error instead. `callTool` no longer rejects at all.
  test('an unknown tool produces an isError result', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'tool_inesistente', arguments: {}});

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Tool tool_inesistente not found/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('invalid arguments produce an isError result naming every missing field', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({
        name: 'create_draft_post',
        arguments: {title: 'title only'},
      });

      assert.equal(result.isError, true);

      const [{text}] = result.content;
      assert.match(text, /Input validation error/);
      // Both missing fields must be reported, not just the first one: a client that only
      // learns about `subtitle` retries and fails again on `body`.
      assert.match(text, /subtitle/);
      assert.match(text, /body/);

      // The handler must not run, so no draft is created from invalid input.
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  // The validation message is the whole feedback loop for an LLM: it is what the model reads
  // to fix a malformed call and retry. These tests treat its content as a contract, not as an
  // implementation detail, because a degraded message does not fail anything on its own — the
  // call still returns, the model just cannot work out what to change.
  describe('the validation message an LLM has to act on', () => {
    async function callWith(args) {
      const {client, close} = await connectMcpClient();

      try {
        const result = await client.callTool({name: 'create_draft_post', arguments: args});
        assert.equal(result.isError, true);
        return result.content[0].text;
      } finally {
        await close();
      }
    }

    test('names every missing field, not just the first', async () => {
      const text = await callWith({});

      for (const field of ['title', 'subtitle', 'body']) {
        assert.match(text, new RegExp(`at ${field}\\b`), `should point at ${field}`);
      }
    });

    test('reports a wrong type with both what was expected and what arrived', async () => {
      const text = await callWith({title: 42, subtitle: 'S', body: 'B'});

      assert.match(text, /expected string, received number at title/);
    });

    test('names an unrecognised key instead of silently dropping it', async () => {
      // The realistic LLM mistake: `content` instead of `body`. Being told only that `body`
      // is missing leaves the model unable to see that its own key was the problem.
      const text = await callWith({title: 'T', subtitle: 'S', content: 'B'});

      assert.match(text, /at body\b/);
      assert.match(text, /Unrecognized key: "content"/);
    });

    test('travels as tool output, which is the channel a model can read', async () => {
      const {client, close} = await connectMcpClient();

      try {
        const result = await client.callTool({name: 'create_draft_post', arguments: {}});

        // Not a JSON-RPC error: an isError result with the reason in text content. A protocol
        // error would leave many clients with nothing to hand back to the model.
        assert.equal(result.isError, true);
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'text');
        assert.ok(result.content[0].text.length > 0, 'the reason must not be empty');
      } finally {
        await close();
      }
    });
  });

  describe('what the log says about a call', () => {
    function find(lines, msg) {
      const line = lines.find((entry) => entry.msg === msg);
      assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
      return line;
    }

    async function callAndCaptureLogs(args) {
      const {client, close} = await connectMcpClient();

      try {
        return await captureLogs(() => client.callTool({name: 'create_draft_post', arguments: args}));
      } finally {
        await close();
      }
    }

    test('a successful call is bracketed by start and success, with its duration', async () => {
      const lines = await callAndCaptureLogs(VALID_ARGS);

      const start = find(lines, 'tool.call.start');
      assert.equal(start.tool, 'create_draft_post');
      assert.deepEqual(start.args, VALID_ARGS);

      const success = find(lines, 'tool.call.success');
      assert.equal(success.tool, 'create_draft_post');
      assert.equal(success.result, 'OK');
      assert.equal(typeof success.duration_ms, 'number');
    });

    test('a failing call logs the error and no success line', async () => {
      msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

      const lines = await callAndCaptureLogs(VALID_ARGS);

      assert.match(find(lines, 'tool.call.error').error.message, /SubstackAPIException: 500/);
      assert.equal(lines.find((entry) => entry.msg === 'tool.call.success'), undefined);
    });

    // McpServer answers a malformed call itself, so nothing inside the tool runs or logs. This
    // is the gap logOutgoingMessages() closes at the transport, which this harness does not
    // wrap — the rejection line itself is asserted in src/logger.spec.js.
    test('a call rejected before the handler runs logs nothing from the tool', async () => {
      const lines = await callAndCaptureLogs({title: 'title only'});

      assert.deepEqual(lines.map((entry) => entry.msg), []);
    });
  });

  test('a Substack API error reaches the client as an isError result', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /SubstackAPIException: 500/);
    } finally {
      await close();
    }
  });
});
