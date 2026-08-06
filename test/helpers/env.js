export const TEST_ENV = {
  SUBSTACK_PUBLICATION_URL: 'https://test.substack.com',
  SUBSTACK_SESSION_TOKEN: 'test-session-token',
  SUBSTACK_USER_ID: '12345',
};

/**
 * Imposta le env var di test e restituisce una funzione che ripristina i valori precedenti,
 * così un file di test non altera l'ambiente visto dagli altri.
 */
export function setTestEnv(overrides = {}) {
  const values = {...TEST_ENV, ...overrides};
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
