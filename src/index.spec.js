import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {TEST_ENV} from '../test/helpers/env.js';

const ENTRYPOINT = fileURLToPath(new URL('./index.js', import.meta.url));

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
].join('\n') + '\n';

const CALL_TOOL = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'create_draft_post',
    arguments: {title: 'A title', subtitle: 'A subtitle', body: 'A body'},
  },
}) + '\n';

/**
 * Runs the real entrypoint as a child process, since index.js does its work at import time
 * and cannot be exercised in-process. `env` fully replaces the SUBSTACK_* variables, so a
 * value leaking in from the developer's shell cannot mask a missing-env test.
 */
function runEntrypoint({env = TEST_ENV, stdin = ''} = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRYPOINT],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...env,
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        // A signal kill — the timeout above firing, say — arrives as `code: null` with
        // `signal` set. Collapsing that to 0 with `?? 0` would make a hung entrypoint
        // indistinguishable from a clean exit, defeating every assertion below that reads
        // the exit code. Report the signal so callers can tell the two apart.
        resolve({code: error ? error.code : 0, signal: error?.signal ?? null, stdout, stderr});
      }
    );

    child.stdin.end(stdin);
  });
}

/**
 * Parses the structured log lines out of the child's stderr. Anything that is not JSON — a
 * stack trace, a Node warning — is dropped, so the callers below assert on the log itself.
 */
function logLines(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

describe('entrypoint — environment check', () => {
  for (const missing of Object.keys(TEST_ENV)) {
    test(`refuses to start when ${missing} is missing`, async () => {
      const env = {...TEST_ENV};
      delete env[missing];

      const {code, signal, stderr} = await runEntrypoint({env});

      assert.equal(signal, null, 'the process should exit on its own, not be killed');
      assert.notEqual(code, 0, 'the process should fail');
      assert.match(
        stderr,
        /SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set/
      );

      // The thrown message lists all three variables whatever is wrong; only the log says
      // which one is actually missing, which is the whole point of logging it.
      const logged = logLines(stderr).find((line) => line.msg === 'server.env.missing');
      assert.deepEqual(logged.missing, [missing]);
    });
  }

  test('refuses to start when an env var is present but empty', async () => {
    const {code, signal, stderr} = await runEntrypoint({
      env: {...TEST_ENV, SUBSTACK_USER_ID: ''},
    });

    assert.equal(signal, null, 'the process should exit on its own, not be killed');
    assert.notEqual(code, 0, 'the process should fail');
    assert.match(stderr, /must be set/);
  });
});

describe('entrypoint — stdio transport', () => {
  // Automates the manual probe documented in CLAUDE.md: a passing unit suite does not prove
  // the binary boots and speaks the protocol over a real stdio transport.
  test('completes the handshake and lists the tools over stdio', async () => {
    const {stdout, stderr, signal} = await runEntrypoint({stdin: HANDSHAKE});

    // Without this, a server that answered the handshake and then hung would still satisfy
    // every assertion below — the replies are already in stdout by the time it is killed.
    assert.equal(signal, null, 'the process should exit on its own, not be killed');

    // stderr now carries the structured log. What must hold is that it carries *only* that:
    // a stray console.log or a warning printed on the wrong stream is how the transport gets
    // corrupted, and JSON.parse below is the only thing standing between the two.
    for (const line of stderr.split('\n').filter((line) => line.trim() !== '')) {
      assert.doesNotThrow(() => JSON.parse(line), `stderr should only carry log lines: ${line}`);
    }

    const messages = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));

    const initialize = messages.find((message) => message.id === 1);
    assert.equal(initialize.result.serverInfo.name, 'Substack MCP');
    // This is the version an MCP client displays, and it is the one number here that a
    // release has to move. As a literal it silently didn't: the published v1.1.0 image
    // still introduced itself as 1.0.0. Reading package.json is what keeps the two equal,
    // and asserting against the same file is what proves it is still being read.
    assert.equal(initialize.result.serverInfo.version, PACKAGE_VERSION);
    assert.equal(initialize.result.protocolVersion, '2024-11-05');
    // Only `tools` is advertised. The server used to declare `resources` and `logging` too
    // while registering no handler for either, so `resources/list` answered -32601 Method
    // not found; McpServer derives capabilities from what is actually registered.
    assert.deepEqual(Object.keys(initialize.result.capabilities), ['tools']);

    const listTools = messages.find((message) => message.id === 2);
    const byName = Object.fromEntries(listTools.result.tools.map((tool) => [tool.name, tool]));

    assert.deepEqual(Object.keys(byName).sort(), [
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
    ]);

    assert.deepEqual(
      Object.keys(byName.create_draft_post.inputSchema.properties).sort(),
      ['body', 'subtitle', 'title']
    );

    // The whole point of listing over a real transport rather than in-process: the 48-value
    // column enum has to survive JSON-RPC serialization to be of any use to a client.
    assert.equal(byName.list_subscribers.inputSchema.properties.filters.items.properties.column.enum.length, 48);
  });

  // The process exits 0 as soon as stdin reaches EOF; that is the documented normal shutdown,
  // not a crash, so exit status alone must never be read as proof the server worked.
  test('exits cleanly when stdin reaches EOF', async () => {
    const {code, signal} = await runEntrypoint({stdin: ''});

    // `signal` carries the whole point of this test: a hung entrypoint gets SIGTERM-ed by the
    // helper's timeout, and a killed process must never read as having exited cleanly.
    assert.equal(signal, null, 'the process should exit on its own, not be killed');
    assert.equal(code, 0);
  });
});

describe('entrypoint — logging', () => {
  test('reports the startup on stderr, leaving stdout to the protocol', async () => {
    const {stdout, stderr, signal} = await runEntrypoint({stdin: HANDSHAKE});

    // Every test reading runEntrypoint asserts this: the helper SIGTERMs a hung child after
    // 10s, and by then the expected output is already captured, so a log assertion alone would
    // pass on a server that logged correctly and then hung.
    assert.equal(signal, null, 'the process should exit on its own, not be killed');

    const messages = logLines(stderr);
    const starting = messages.find((line) => line.msg === 'server.starting');
    const registered = messages.find((line) => line.msg === 'tool.registered');
    const ready = messages.find((line) => line.msg === 'server.ready');

    assert.equal(starting.publication_url, TEST_ENV.SUBSTACK_PUBLICATION_URL);
    assert.equal(starting.user_id, TEST_ENV.SUBSTACK_USER_ID);
    assert.equal(registered.tool, 'create_draft_post');
    assert.equal(ready.transport, 'stdio');

    // Everything on stdout must still parse as JSON-RPC: no log line may have leaked there.
    for (const line of stdout.split('\n').filter((line) => line.trim() !== '')) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0');
    }
  });

  // The token only ever reaches a log line through the Cookie header of an outgoing request,
  // so the handshake alone cannot prove it is redacted — asserting on it there passes whether
  // redaction works or not. This drives a real tool call instead, at debug level, and points
  // the publication at a closed local port: the request is logged before fetch is called, then
  // fails with ECONNREFUSED without a packet leaving the machine. MSW cannot help here, it
  // cannot instrument a child process.
  test('never writes the session token to the log, not even in a request header', async () => {
    const {stderr, signal} = await runEntrypoint({
      env: {
        ...TEST_ENV,
        SUBSTACK_PUBLICATION_URL: 'http://127.0.0.1:1',
        SUBSTACK_MCP_LOG_LEVEL: 'debug',
      },
      stdin: HANDSHAKE + CALL_TOOL,
    });

    assert.equal(signal, null, 'the process should exit on its own, not be killed');

    const request = logLines(stderr).find((line) => line.msg === 'substack.request');

    assert.ok(request, 'the request must be logged, or this test asserts nothing');
    assert.equal(request.headers.Cookie, '***');
    assert.doesNotMatch(stderr, new RegExp(TEST_ENV.SUBSTACK_SESSION_TOKEN));
  });

  test('logs the failure of a tool call, with the reason the client is given', async () => {
    const {stderr, signal} = await runEntrypoint({
      env: {
        ...TEST_ENV,
        SUBSTACK_PUBLICATION_URL: 'http://127.0.0.1:1',
        SUBSTACK_MCP_LOG_LEVEL: 'debug',
      },
      stdin: HANDSHAKE + CALL_TOOL,
    });

    assert.equal(signal, null, 'the process should exit on its own, not be killed');

    const lines = logLines(stderr);
    const start = lines.find((line) => line.msg === 'tool.call.start');
    const failed = lines.find((line) => line.msg === 'substack.request.failed');
    const error = lines.find((line) => line.msg === 'tool.call.error');

    assert.equal(start.tool, 'create_draft_post');
    assert.equal(start.args.title, 'A title');
    assert.equal(typeof failed.duration_ms, 'number');
    // The detail behind the failure is the part the client never sees: it exists only in the
    // log. `fetch` rejects with a bare `TypeError: fetch failed` whose stack has no frames of
    // its own on Node 24 — every actionable byte hangs off `cause`, so that is what has to
    // reach the log for a transport failure to be diagnosable at all.
    assert.equal(error.error.message, 'fetch failed');
    assert.ok(error.error.cause, 'the cause must be logged, or the line says only that it failed');
    assert.match(error.error.cause.stack, /\n\s+at /, 'the cause must carry stack frames');
  });

  test('SUBSTACK_MCP_LOG_LEVEL=silent produces no output while the server still works', async () => {
    const {stdout, stderr, signal} = await runEntrypoint({
      env: {...TEST_ENV, SUBSTACK_MCP_LOG_LEVEL: 'silent'},
      stdin: HANDSHAKE,
    });

    assert.equal(signal, null, 'the process should exit on its own, not be killed');
    assert.equal(stderr, '');

    const listTools = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);

    assert.equal(listTools.result.tools[0].name, 'create_draft_post');
  });
});
