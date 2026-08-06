import {setupServer} from 'msw/node';
import {http, HttpResponse} from 'msw';
import {TEST_ENV} from './env.js';

export const DRAFTS_URL = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}/api/v1/drafts`;

export const DRAFT_RESPONSE = {
  id: 167712345,
  draft_title: 'Test title',
  draft_subtitle: 'Test subtitle',
  is_published: false,
};

/**
 * Creates the MSW server used by the integration tests.
 *
 * `requests` accumulates every intercepted request: {method, url, headers, body}.
 * `draftsHandler(responder)` builds a handler for POST /drafts that records the request and
 * then delegates the response to `responder`. Use it for overrides passed to `server.use()`
 * as well, otherwise that request never reaches the log.
 */
export function createMswServer() {
  const requests = [];

  async function record(request) {
    const raw = await request.clone().text();

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    requests.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    });
  }

  function draftsHandler(responder) {
    return http.post(DRAFTS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  const server = setupServer(
    draftsHandler(() => HttpResponse.json(DRAFT_RESPONSE, {status: 200}))
  );

  return {
    server,
    requests,
    draftsHandler,
    start() {
      server.listen({onUnhandledRequest: 'error'});
    },
    reset() {
      server.resetHandlers();
      requests.length = 0;
    },
    stop() {
      server.close();
    },
  };
}
