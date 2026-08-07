// Structured logging for the whole server, in one place.
//
// Everything goes to **stderr**, never stdout: on a stdio transport stdout carries the
// JSON-RPC stream, and a single byte written there corrupts the protocol and drops the
// client. MCP hosts (Claude Desktop, Claude Code, Cursor) collect the server's stderr into
// their own log files, which is where these lines are meant to be read.
//
// One JSON object per line, so a log file can be filtered with grep and parsed with jq:
//   {"ts":"2026-08-07T10:12:03.114Z","level":"info","msg":"tool.call.start","tool":"…"}

const LEVELS = {silent: 0, error: 1, warn: 2, info: 3, debug: 4};

const DEFAULT_LEVEL = 'info';

// Keys whose value must never reach a log file. Matched on the key, not the value, so a
// token nested anywhere in a payload is redacted without every call site remembering to.
// `sid` is anchored on purpose: as a substring it would also redact `consider`, `aside` and
// anything else that happens to contain it. `session` covers `session_id` and `session_token`.
const SECRET_KEY = /token|cookie|password|secret|auth|session|^sid$/i;

const REDACTED = '***';

// Read at call time, not at import: SUBSTACK_MCP_LOG_LEVEL may be set after this module is
// imported (tests do exactly that), and no module here may read the environment at import
// time. An unknown value falls back to the default rather than silencing the server.
function currentLevel() {
  const configured = (process.env.SUBSTACK_MCP_LOG_LEVEL || '').trim().toLowerCase();
  return LEVELS[configured] ?? LEVELS[DEFAULT_LEVEL];
}

/**
 * Copies `value`, replacing secrets with `***`. Errors become plain objects — JSON.stringify
 * renders an Error as `{}`, which is how a stack trace silently disappears from a log. Cycles
 * are cut with `[Circular]`; `seen` is unwound on the way out so that a value merely repeated
 * across siblings is still logged in full.
 */
function redact(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    // `cause` is not a nice-to-have: it is sometimes the only place the diagnosis exists.
    // Native `fetch` rejects with `TypeError: fetch failed` whose stack carries *no frames*
    // on Node 24 (on Node 22 it still had the caller's async frames), and the underlying
    // network error — with its own message and stack — hangs off `.cause`. Dropping it leaves
    // a line stating that something failed and nothing about what. It goes back through
    // `redact` rather than being copied: a cause is an ordinary payload, secrets and all.
    const expanded = {name: value.name, message: value.message, stack: value.stack};

    if (value.cause !== undefined) {
      expanded.cause = redact(value.cause, seen);
    }

    seen.delete(value);
    return expanded;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  const redacted = Array.isArray(value)
    ? value.map((item) => redact(item, seen))
    : Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        // A boolean under a secret key is kept: one bit cannot leak a credential, and the
        // diagnostic flags worth logging are named after the secret they describe. Redacting
        // `has_auth_token` would silently turn the only useful part of the line into `***`.
        SECRET_KEY.test(key) && typeof item !== 'boolean' ? REDACTED : redact(item, seen),
      ])
    );

  seen.delete(value);
  return redacted;
}

function emit(level, msg, fields) {
  if (LEVELS[level] > currentLevel()) {
    return;
  }

  const ts = new Date().toISOString();
  let line;

  try {
    line = JSON.stringify({ts, level, msg, ...redact(fields ?? {})});
  } catch (error) {
    // A logger that throws is worse than no logger at all: it would fail the tool call it was
    // only supposed to describe. BigInt and getters that throw still get here past `redact`.
    line = JSON.stringify({ts, level, msg, log_error: `unserializable fields: ${error.message}`});
  }

  process.stderr.write(`${line}\n`);
}

export const logger = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};

/**
 * Logs every message the server sends, by wrapping `transport.send` in place.
 *
 * This is the only way to see a rejected tool call: `McpServer` validates arguments against
 * the tool schema itself and answers with an `Input validation error` before the registered
 * handler runs, so nothing inside the handler can report it. That rejection is the single
 * most useful line when an LLM cannot get a call right, hence `warn` for failures and
 * `debug` for the rest of the traffic.
 */
export function logOutgoingMessages(transport) {
  const send = transport.send.bind(transport);

  transport.send = async (message, options) => {
    if (message?.error) {
      logger.warn('protocol.error', {id: message.id, error: message.error});
    } else if (message?.result?.isError) {
      logger.warn('tool.result.error', {id: message.id, content: message.result.content});
    } else {
      logger.debug('protocol.send', {message});
    }

    return send(message, options);
  };

  return transport;
}
