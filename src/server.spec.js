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

  test('an unknown tool produces an error', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'tool_inesistente', arguments: {}})
        .catch((e) => e);

      assert.match(error.message, /Unknown tool: tool_inesistente/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('invalid arguments produce an Invalid input error carrying the Zod details', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'create_draft_post', arguments: {title: 'title only'}})
        .catch((e) => e);

      assert.match(error.message, /Invalid input:/);
      assert.match(error.message, /"path":\["subtitle"\]/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('a Substack API error propagates to the client', async () => {
    msw.server.use(msw.draftsHandler(() => new HttpResponse('boom', {status: 500})));

    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'create_draft_post', arguments: VALID_ARGS})
        .catch((e) => e);

      assert.match(error.message, /500/);
    } finally {
      await close();
    }
  });
});
