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

const VALID_ARGS = {title: 'Titolo', subtitle: 'Sottotitolo', body: 'Corpo'};

describe('MCP server — list_tools', () => {
  test('espone create_draft_post con la sua descrizione', async () => {
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

  test('pubblica un inputSchema con i tre campi obbligatori', async () => {
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
  test('esegue il tool e restituisce il risultato serializzato', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.deepEqual(result.content, [{type: 'text', text: '"OK"'}]);
    } finally {
      await close();
    }
  });

  test('la chiamata raggiunge l\'API Substack', async () => {
    const {client, close} = await connectMcpClient();

    try {
      await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      assert.equal(msw.requests.length, 1);
      assert.equal(msw.requests[0].url, DRAFTS_URL);
      assert.equal(msw.requests[0].body.draft_title, 'Titolo');
    } finally {
      await close();
    }
  });

  test('un tool sconosciuto produce un errore', async () => {
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

  test('argomenti invalidi producono un errore Invalid input con i dettagli Zod', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const error = await client
        .callTool({name: 'create_draft_post', arguments: {title: 'solo il titolo'}})
        .catch((e) => e);

      assert.match(error.message, /Invalid input:/);
      assert.match(error.message, /"path":\["subtitle"\]/);
      assert.equal(msw.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('un errore dell\'API Substack si propaga al client', async () => {
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
