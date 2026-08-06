import {test, describe, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {logger, logOutgoingMessages} from './logger.js';

let savedLevel;

beforeEach(() => {
  savedLevel = process.env.SUBSTACK_MCP_LOG_LEVEL;
});

afterEach(() => {
  if (savedLevel === undefined) {
    delete process.env.SUBSTACK_MCP_LOG_LEVEL;
  } else {
    process.env.SUBSTACK_MCP_LOG_LEVEL = savedLevel;
  }
});

/**
 * Records what the logger writes to each stream and returns both. It asserts nothing itself —
 * `logLines` below is what checks that stdout stayed empty, since on a stdio transport stdout
 * belongs to the JSON-RPC stream. Use `logLines` unless a test needs the raw chunks.
 */
function capture(run) {
  const stderr = [];
  const stdout = [];
  const originalStderr = process.stderr.write;
  const originalStdout = process.stdout.write;

  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };

  try {
    run();
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }

  return {stderr, stdout};
}

function logLines(run) {
  const {stderr, stdout} = capture(run);

  assert.deepEqual(stdout, [], 'the logger must never write to stdout');

  return stderr
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

describe('logger — levels', () => {
  test('info is the default: error, warn and info pass, debug does not', () => {
    delete process.env.SUBSTACK_MCP_LOG_LEVEL;

    const lines = logLines(() => {
      logger.error('an error');
      logger.warn('a warning');
      logger.info('an info');
      logger.debug('a debug');
    });

    assert.deepEqual(lines.map((line) => line.msg), ['an error', 'a warning', 'an info']);
  });

  test('debug lets everything through', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'debug';

    const lines = logLines(() => {
      logger.error('an error');
      logger.debug('a debug');
    });

    assert.deepEqual(lines.map((line) => line.level), ['error', 'debug']);
  });

  test('silent writes nothing at all', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'silent';

    const lines = logLines(() => {
      logger.error('an error');
      logger.warn('a warning');
      logger.info('an info');
      logger.debug('a debug');
    });

    assert.deepEqual(lines, []);
  });

  test('error only silences everything below it', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'error';

    const lines = logLines(() => {
      logger.error('an error');
      logger.warn('a warning');
      logger.info('an info');
    });

    assert.deepEqual(lines.map((line) => line.msg), ['an error']);
  });

  test('the value is read per call, not at import', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'silent';

    const lines = logLines(() => {
      logger.info('suppressed');
      process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';
      logger.info('emitted');
    });

    assert.deepEqual(lines.map((line) => line.msg), ['emitted']);
  });

  test('an unknown level falls back to info rather than muting the server', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'verbose';

    const lines = logLines(() => {
      logger.info('an info');
      logger.debug('a debug');
    });

    assert.deepEqual(lines.map((line) => line.msg), ['an info']);
  });

  test('the level is matched case-insensitively and trimmed', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = '  DEBUG  ';

    const lines = logLines(() => logger.debug('a debug'));

    assert.equal(lines.length, 1);
  });
});

describe('logger — line format', () => {
  test('emits one JSON line per call, carrying ts, level, msg and the fields', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const {stderr} = capture(() => logger.info('tool.call.start', {tool: 'create_draft_post'}));

    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].endsWith('\n'), 'the line must be newline-terminated');

    const line = JSON.parse(stderr[0]);
    assert.equal(line.level, 'info');
    assert.equal(line.msg, 'tool.call.start');
    assert.equal(line.tool, 'create_draft_post');
    // A timestamp is what makes two lines comparable when reading a log after the fact.
    assert.equal(new Date(line.ts).toISOString(), line.ts);
  });

  test('works with no fields at all', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const [line] = logLines(() => logger.info('server.ready'));

    assert.deepEqual(Object.keys(line).sort(), ['level', 'msg', 'ts']);
  });
});

describe('logger — redaction', () => {
  test('replaces secrets by key name, however deeply nested', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const [line] = logLines(() => logger.info('substack.request', {
      url: 'https://test.substack.com/api/v1/drafts',
      auth_token: 'super-secret',
      headers: {Cookie: 'substack.sid=super-secret;', 'Content-Type': 'application/json'},
      nested: [{password: 'hunter2'}, {session_id: 'abc'}, {sid: 'xyz'}],
    }));

    assert.equal(line.url, 'https://test.substack.com/api/v1/drafts');
    assert.equal(line.auth_token, '***');
    assert.equal(line.headers.Cookie, '***');
    assert.equal(line.headers['Content-Type'], 'application/json');
    assert.equal(line.nested[0].password, '***');
    assert.equal(line.nested[1].session_id, '***');
    assert.equal(line.nested[2].sid, '***');

    // The point of redacting by key: the value must not survive anywhere in the line.
    assert.doesNotMatch(JSON.stringify(line), /super-secret|hunter2|xyz/);
  });

  // `has_auth_token` matches the pattern twice over, and redacting it produced
  // `"has_auth_token":"***"` — a line stating only that the field exists. A boolean cannot
  // carry a credential, so it survives; anything else under the same key does not.
  test('keeps a boolean flag named after a secret, but not a string value', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'debug';

    const [line] = logLines(() => logger.debug('substack_api.created', {
      has_auth_token: true,
      has_password: false,
      auth_token: 'super-secret',
    }));

    assert.equal(line.has_auth_token, true);
    assert.equal(line.has_password, false);
    assert.equal(line.auth_token, '***');
  });

  // The counterpart of the anchored `sid` alternative: matching it as a substring would blank
  // out ordinary fields, and a log full of `***` is as useless as no log.
  test('does not redact keys that merely contain a secret word as a substring', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const [line] = logLines(() => logger.info('draft.built', {
      considerations: 'kept',
      subtitle: 'kept',
      draft_section_id: 42,
    }));

    assert.equal(line.considerations, 'kept');
    assert.equal(line.subtitle, 'kept');
    assert.equal(line.draft_section_id, 42);
  });

  test('leaves the post content untouched — that is what is being debugged', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const body = 'A'.repeat(5000);
    const [line] = logLines(() => logger.info('tool.call.start', {args: {title: 'T', body}}));

    assert.equal(line.args.body, body);
  });
});

describe('logger — resilience', () => {
  test('renders an Error with its message and stack instead of {}', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const [line] = logLines(() => logger.error('tool.call.error', {
      error: new Error('SubstackAPIException: 500 Internal Server Error'),
    }));

    assert.equal(line.error.name, 'Error');
    assert.equal(line.error.message, 'SubstackAPIException: 500 Internal Server Error');
    assert.match(line.error.stack, /logger\.spec\.js/);
  });

  test('a circular payload is logged rather than throwing', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const draft = {title: 'T'};
    draft.self = draft;

    const [line] = logLines(() => logger.info('draft.built', {draft}));

    assert.equal(line.draft.title, 'T');
    assert.equal(line.draft.self, '[Circular]');
  });

  test('a value repeated across siblings is not mistaken for a cycle', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const shared = {type: 'text'};
    const [line] = logLines(() => logger.info('draft.built', {content: [shared, shared]}));

    assert.deepEqual(line.content, [{type: 'text'}, {type: 'text'}]);
  });

  test('an unserializable field degrades to a note, and never throws', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const [line] = logLines(() => logger.info('tool.call.start', {args: {id: 10n}}));

    assert.equal(line.msg, 'tool.call.start');
    assert.match(line.log_error, /unserializable fields/);
  });
});

describe('logOutgoingMessages', () => {
  function fakeTransport() {
    const sent = [];
    return {
      sent,
      send(message, options) {
        sent.push({message, options});
        return Promise.resolve('sent');
      },
    };
  }

  test('logs a rejected tool call at warn — the SDK answers those without the handler running', async () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const transport = logOutgoingMessages(fakeTransport());
    const message = {
      jsonrpc: '2.0',
      id: 2,
      result: {isError: true, content: [{type: 'text', text: 'Input validation error: …'}]},
    };

    const lines = logLines(() => transport.send(message));

    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'warn');
    assert.equal(lines[0].msg, 'tool.result.error');
    assert.equal(lines[0].id, 2);
    assert.match(lines[0].content[0].text, /Input validation error/);
  });

  test('logs a JSON-RPC error at warn', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const transport = logOutgoingMessages(fakeTransport());

    const lines = logLines(() => transport.send({
      jsonrpc: '2.0',
      id: 3,
      error: {code: -32601, message: 'Method not found'},
    }));

    assert.deepEqual(lines.map((line) => [line.level, line.msg]), [['warn', 'protocol.error']]);
    assert.equal(lines[0].error.code, -32601);
  });

  test('successful traffic is debug-only, so info stays readable', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'info';

    const transport = logOutgoingMessages(fakeTransport());
    const lines = logLines(() => transport.send({jsonrpc: '2.0', id: 1, result: {tools: []}}));

    assert.deepEqual(lines, []);
  });

  test('successful traffic is logged at debug', () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'debug';

    const transport = logOutgoingMessages(fakeTransport());
    const lines = logLines(() => transport.send({jsonrpc: '2.0', id: 1, result: {tools: []}}));

    assert.deepEqual(lines.map((line) => line.msg), ['protocol.send']);
  });

  test('still delivers the message, with its options and return value intact', async () => {
    process.env.SUBSTACK_MCP_LOG_LEVEL = 'silent';

    const transport = fakeTransport();
    logOutgoingMessages(transport);

    const message = {jsonrpc: '2.0', id: 1, result: {}};
    const returned = await transport.send(message, {relatedRequestId: 7});

    assert.equal(returned, 'sent');
    assert.deepEqual(transport.sent, [{message, options: {relatedRequestId: 7}}]);
  });
});
