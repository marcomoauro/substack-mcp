import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import {connectMcpClient} from '../test/helpers/mcp-harness.js';
import {createMswServer, DRAFTS_URL} from '../test/helpers/msw-server.js';
import {setTestEnv} from '../test/helpers/env.js';

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

  test('the inputSchema is a draft-07 document generated in input mode', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const {inputSchema} = tools[0];

      assert.equal(inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
      // `io: 'input'` deliberately omits additionalProperties: a zod object strips unknown
      // keys rather than rejecting them, so advertising `false` would misdescribe the tool.
      assert.equal(Object.hasOwn(inputSchema, 'additionalProperties'), false);
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
