import {test, describe, before, after, afterEach} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {HttpResponse} from 'msw';
import {connectMcpClient} from '../test/helpers/mcp-harness.js';
import {tools} from './server.js';
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
  // Indexed by name rather than position: the registry is an object, and asserting on tools[0]
  // makes every one of these tests depend on the declaration order of an unrelated tool.
  async function listToolsByName() {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    } finally {
      await close();
    }
  }

  const EXPECTED_TOOLS = [
    'add_tag_to_post',
    'comment_on_post',
    'create_draft_post',
    'delete_draft',
    'export_subscribers',
    'get_analytics',
    'get_comment_thread',
    'get_draft',
    'get_post_comments',
    'get_post_stats',
    'get_post_tags',
    'get_profile_feed',
    'get_publication',
    'get_publication_stats',
    'get_reader_feed',
    'get_reader_post',
    'get_user_profile',
    'list_posts',
    'list_publication_tags',
    'list_reader_posts',
    'list_subscribers',
    'list_subscriptions',
    'publish_draft',
    'restack_item',
    'set_post_body',
    'update_draft',
    'upload_image',
  ];

  test('exposes exactly the registered tools', async () => {
    const tools = await listToolsByName();

    assert.deepEqual(Object.keys(tools).sort(), EXPECTED_TOOLS);
  });

  test('every tool carries a description', async () => {
    const tools = await listToolsByName();

    for (const name of EXPECTED_TOOLS) {
      assert.ok(tools[name].description, `${name} should carry a description`);
    }

    assert.equal(tools.create_draft_post.description, 'create a draft post on your Substack account.');
  });

  test('create_draft_post publishes an inputSchema with the three required fields', async () => {
    const {inputSchema} = (await listToolsByName()).create_draft_post;

    assert.equal(inputSchema.type, 'object');
    assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['body', 'subtitle', 'title']);
    assert.deepEqual([...inputSchema.required].sort(), ['body', 'subtitle', 'title']);
    assert.equal(inputSchema.properties.title.type, 'string');
  });

  test('upload_image advertises url + optional post_id and forbids extra keys', async () => {
    const {inputSchema} = (await listToolsByName()).upload_image;

    assert.equal(inputSchema.type, 'object');
    assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['post_id', 'url']);
    assert.deepEqual([...(inputSchema.required ?? [])], ['url']);
    assert.equal(inputSchema.additionalProperties, false);
  });

  // Regression guard for the zod 3 -> 4 migration: zod-to-json-schema silently returned a
  // bare `{$schema}` for a zod 4 schema instead of throwing, which would have published a
  // parameterless tool. Asserting the descriptions — the part an LLM actually reads to fill
  // the arguments — is what makes a degraded-but-structurally-valid schema fail here.
  test('every property of every tool carries the description the LLM relies on', async () => {
    const tools = await listToolsByName();

    for (const name of EXPECTED_TOOLS) {
      for (const [property, definition] of Object.entries(tools[name].inputSchema.properties ?? {})) {
        assert.ok(definition.description, `${name}.${property} should carry a description`);
      }
    }

    const {properties} = tools.create_draft_post.inputSchema;
    assert.match(properties.body.description, /plain text|JSON string/);
  });

  test('every inputSchema is a draft-07 document that closes the object', async () => {
    const tools = await listToolsByName();

    for (const name of EXPECTED_TOOLS) {
      const {inputSchema} = tools[name];

      assert.equal(inputSchema.$schema, 'http://json-schema.org/draft-07/schema#', name);
      // Accurate only because the schemas are strictObjects: a plain z.object strips unknown
      // keys instead of rejecting them, and would publish this as an empty promise.
      assert.equal(inputSchema.additionalProperties, false, name);
    }
  });

  // The 48 column names reach the model only through this enum. If the schema ever published
  // `column` as a bare string the tool would still work for a caller that already knows the
  // names, and be unusable for one that does not.
  test('list_subscribers publishes the filterable columns as an enum', async () => {
    const {inputSchema} = (await listToolsByName()).list_subscribers;
    const {column, operator} = inputSchema.properties.filters.items.properties;

    assert.equal(column.enum.length, 48);
    assert.ok(column.enum.includes('num_email_opens_last_30d'));
    assert.ok(column.enum.includes('subscription_type'));
    assert.ok(operator.enum.includes('is_any_of'));
    assert.ok(operator.enum.includes('is_on_or_before'));
  });
});

describe('MCP server — call_tool', () => {
  test('runs the tool and returns the serialized result', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({name: 'create_draft_post', arguments: VALID_ARGS});

      // Serialized by the server, so the id arrives as JSON text rather than an object.
      assert.deepEqual(result.content, [
        {type: 'text', text: JSON.stringify({draft_id: 167712345, is_published: false}, null, 2)},
      ]);
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
      assert.deepEqual(success.result, {draft_id: 167712345, is_published: false});
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

describe('MCP server — set_post_body over the protocol', () => {
  async function publishedSchema() {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      return tools.find(tool => tool.name === 'set_post_body')?.inputSchema;
    } finally {
      await close();
    }
  }

  test('is registered and published with exactly a draft_id and a body', async () => {
    const schema = await publishedSchema();

    assert.ok(schema, 'set_post_body should be registered');
    assert.deepEqual(Object.keys(schema.properties).sort(), ['body', 'draft_id']);
    assert.equal(schema.additionalProperties, false);
  });

  // The published schema is what teaches a model the vocabulary. If the node names stop appearing in
  // it the tool still works and every caller has to guess, which no other test would notice.
  test('publishes the node vocabulary a caller has to know', async () => {
    const published = JSON.stringify(await publishedSchema());

    for (const type of [
      'paragraph', 'heading', 'bullet_list', 'ordered_list', 'blockquote',
      'highlighted_code_block', 'code_block', 'horizontal_rule', 'paywall',
      'captionedImage', 'image2', 'caption', 'button', 'youtube2',
      'digestPostEmbed', 'substack_mentions', 'directMessage',
      'strong', 'em', 'code', 'strikethrough', 'link',
    ]) {
      assert.match(published, new RegExp(`"${type}"`), `${type} should appear in the published schema`);
    }
  });

  // The recursion has to survive conversion, and draft-7 puts the shared shapes under `definitions`.
  // Asserting the refs *exist* first is the point: with no recursion the schema contains none, so a
  // loop over discovered refs would pass while checking nothing.
  test('publishes a self-contained schema, definitions included', async () => {
    const schema = await publishedSchema();
    const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g)].map(m => m[1]);

    assert.ok(refs.length > 0, 'the recursive list and blockquote nodes should produce at least one $ref');

    for (const ref of refs) {
      assert.ok(schema.definitions?.[ref], `definitions.${ref} should exist`);
    }
  });

  // McpServer turns anything a tool throws into a *successful* CallToolResult with isError set, so
  // callTool does not reject. Asserting on a rejection here would check nothing.
  test('reports an unmodelled node as an error result rather than rejecting', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({
        name: 'set_post_body',
        arguments: {draft_id: 1, body: {type: 'doc', content: [{type: 'codeBlock'}]}},
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /discriminator|codeBlock|Invalid/);
    } finally {
      await close();
    }
  });

  test('reports a second paywall as an error result', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const result = await client.callTool({
        name: 'set_post_body',
        arguments: {draft_id: 1, body: {type: 'doc', content: [{type: 'paywall'}, {type: 'paywall'}]}},
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /at most one paywall/i);
    } finally {
      await close();
    }
  });
});

describe('MCP server — the cost of the published document schema', () => {
  // The document schema is the largest thing this server publishes, and the reason it lives on
  // set_post_body alone. Nothing else stops someone adding `body: postBodySchema` to a second tool,
  // where it would be paid again by every session — including the ones that never write a post. This
  // test is that stop: it asserts the node vocabulary appears in exactly one tool's inputSchema.
  test('publishes the document vocabulary on exactly one tool', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const carrying = tools
        .filter(tool => JSON.stringify(tool.inputSchema).includes('"highlighted_code_block"'))
        .map(tool => tool.name);

      assert.deepEqual(carrying, ['set_post_body']);
    } finally {
      await close();
    }
  });

  // Not an exact byte count — that would rot on every node added. A ceiling, so a change that
  // doubles what every session downloads fails here instead of going unnoticed.
  test('keeps the published schema under 32 KB', async () => {
    const {client, close} = await connectMcpClient();

    try {
      const {tools} = await client.listTools();
      const schema = tools.find(tool => tool.name === 'set_post_body').inputSchema;
      const bytes = JSON.stringify(schema).length;

      assert.ok(bytes < 32768, `the published schema is ${bytes} bytes, which is over the 32 KB ceiling`);
      assert.ok(bytes > 8192, `the published schema is only ${bytes} bytes — did the node union shrink?`);
    } finally {
      await close();
    }
  });
});

describe('README — documents every registered tool', () => {
  // The README is the only documentation a user of the published package reads, and nothing else
  // keeps it in step with the registry: set_post_body shipped registered but undocumented, and no
  // test noticed. This compares the two sets in both directions, because each failure hurts
  // differently — a tool missing from the README is invisible to whoever installs the package, while
  // a README entry with no tool behind it sends someone to call something that answers an error.
  const readmeToolNames = () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    // Only lowercase snake_case names: the same markup wraps the two installation options
    // ("Option 1: Using NPX"), which are not tools.
    return [...readme.matchAll(/<summary><strong>([a-z_]+)<\/strong>/g)].map(match => match[1]).sort();
  };

  test('every registered tool has a README section, and every documented tool is registered', () => {
    assert.deepEqual(readmeToolNames(), Object.keys(tools).sort());
  });

  test('no tool is documented twice', () => {
    const documented = readmeToolNames();

    assert.deepEqual(documented, [...new Set(documented)]);
  });
});
