export const TEST_ENV = {
  SUBSTACK_PUBLICATION_URL: 'https://test.substack.com',
  SUBSTACK_SESSION_TOKEN: 'test-session-token',
  SUBSTACK_USER_ID: '12345',
};

/**
 * Sets the test env vars and returns a function restoring the previous values, so that one
 * test file does not alter the environment the others see.
 *
 * Logging is silenced by default: the in-process suites would otherwise print a line per tool
 * call over the test reporter's output. It is not part of TEST_ENV because index.spec.js
 * iterates over that object's keys to build one missing-variable test each, and the log level
 * is optional — the server must start without it. Pass an override to inspect the logs.
 */
export function setTestEnv(overrides = {}) {
  const values = {...TEST_ENV, SUBSTACK_MCP_LOG_LEVEL: 'silent', ...overrides};
  const saved = {};

  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    process.env[key] = values[key];
  }

  return function restoreEnv() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
