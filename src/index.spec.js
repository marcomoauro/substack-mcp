import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TEST_ENV} from '../test/helpers/env.js';

const ENTRYPOINT = fileURLToPath(new URL('./index.js', import.meta.url));

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
].join('\n') + '\n';

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
        resolve({code: error?.code ?? 0, stdout, stderr});
      }
    );

    child.stdin.end(stdin);
  });
}

describe('entrypoint — environment check', () => {
  for (const missing of Object.keys(TEST_ENV)) {
    test(`refuses to start when ${missing} is missing`, async () => {
      const env = {...TEST_ENV};
      delete env[missing];

      const {code, stderr} = await runEntrypoint({env});

      assert.notEqual(code, 0, 'the process should fail');
      assert.match(
        stderr,
        /SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set/
      );
    });
  }

  test('refuses to start when an env var is present but empty', async () => {
    const {code, stderr} = await runEntrypoint({env: {...TEST_ENV, SUBSTACK_USER_ID: ''}});

    assert.notEqual(code, 0, 'the process should fail');
    assert.match(stderr, /must be set/);
  });
});

describe('entrypoint — stdio transport', () => {
  // Automates the manual probe documented in CLAUDE.md: a passing unit suite does not prove
  // the binary boots and speaks the protocol over a real stdio transport.
  test('completes the handshake and lists the tools over stdio', async () => {
    const {stdout, stderr} = await runEntrypoint({stdin: HANDSHAKE});

    assert.equal(stderr, '', 'nothing should be written to stderr');

    const messages = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));

    const initialize = messages.find((message) => message.id === 1);
    assert.equal(initialize.result.serverInfo.name, 'Substack MCP');
    assert.equal(initialize.result.protocolVersion, '2024-11-05');
    // Only `tools` is advertised. The server used to declare `resources` and `logging` too
    // while registering no handler for either, so `resources/list` answered -32601 Method
    // not found; McpServer derives capabilities from what is actually registered.
    assert.deepEqual(Object.keys(initialize.result.capabilities), ['tools']);

    const listTools = messages.find((message) => message.id === 2);
    assert.equal(listTools.result.tools.length, 1);
    assert.equal(listTools.result.tools[0].name, 'create_draft_post');
    assert.deepEqual(
      Object.keys(listTools.result.tools[0].inputSchema.properties).sort(),
      ['body', 'subtitle', 'title']
    );
  });

  // The process exits 0 as soon as stdin reaches EOF; that is the documented normal shutdown,
  // not a crash, so exit status alone must never be read as proof the server worked.
  test('exits cleanly when stdin reaches EOF', async () => {
    const {code} = await runEntrypoint({stdin: ''});

    assert.equal(code, 0);
  });
});
