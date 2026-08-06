/**
 * Runs `run` with logging forced to `level` and returns the log lines it produced, parsed.
 *
 * The logger writes straight to stderr, so this replaces `process.stderr.write` for the
 * duration of the call and restores it afterwards — including when `run` throws, otherwise a
 * single failing assertion would swallow the output of every test that follows.
 *
 * `src/logger.spec.js` keeps its own capture: it also has to prove nothing reaches stdout,
 * which is the logger's own contract rather than something its callers can assert.
 */
export async function captureLogs(run, {level = 'debug'} = {}) {
  const saved = process.env.SUBSTACK_MCP_LOG_LEVEL;
  process.env.SUBSTACK_MCP_LOG_LEVEL = level;

  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    await run();
  } finally {
    process.stderr.write = originalWrite;

    if (saved === undefined) {
      delete process.env.SUBSTACK_MCP_LOG_LEVEL;
    } else {
      process.env.SUBSTACK_MCP_LOG_LEVEL = saved;
    }
  }

  return chunks
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}
