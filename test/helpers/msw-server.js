import {setupServer} from 'msw/node';
import {http, HttpResponse} from 'msw';
import {TEST_ENV} from './env.js';

const API = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}/api/v1`;

export const DRAFTS_URL = `${API}/drafts`;
export const SUBSCRIBER_STATS_URL = `${API}/subscriber-stats`;
export const POST_MANAGEMENT_URL = `${API}/post_management`;
export const DASHBOARD_SUMMARY_URL = `${API}/publish-dashboard/summary`;
export const OPEN_RATE_URL = `${API}/publication/stats/email_stats/30d_open_rate`;
export const VIEWS_30D_URL = `${API}/publication/stats/publication_traffic/30d_views`;

export const DRAFT_RESPONSE = {
  id: 167712345,
  draft_title: 'Test title',
  draft_subtitle: 'Test subtitle',
  is_published: false,
};

// Shaped after a real response: the endpoint answers with the page of subscribers plus `count`,
// the total matching the filters regardless of `limit`.
export const SUBSCRIBER_STATS_RESPONSE = {
  count: 2,
  subscribers: [
    {
      user_id: 1,
      user_email_address: 'one@example.com',
      user_name: 'One',
      subscription_type: 'free',
      activity_rating: 3,
      subscription_created_at: '2026-01-01T00:00:00.000000+00:00',
      total_revenue_generated: 0,
    },
    {
      user_id: 2,
      user_email_address: 'two@example.com',
      user_name: 'Two',
      subscription_type: 'paid',
      activity_rating: 5,
      subscription_created_at: '2026-02-01T00:00:00.000000+00:00',
      total_revenue_generated: 50,
    },
  ],
  order: {by: 'subscription_created_at', direction: 'desc'},
  columnView: [{key: 'subscription_type', visible: true}],
  lastSync: '2026-08-07T08:00:00.000Z',
};

export const POSTS_RESPONSE = {
  posts: [
    {id: 10, title: 'Published one', slug: 'published-one', is_published: true, audience: 'everyone'},
    {id: 11, title: 'Published two', slug: 'published-two', is_published: true, audience: 'only_paid'},
  ],
  offset: 0,
  limit: 25,
  total: 861,
  isCapped: false,
};

export const DRAFT_DETAIL_RESPONSE = {
  id: 167712345,
  draft_title: 'A draft',
  draft_subtitle: 'Its subtitle',
  draft_body: '{"type":"doc","content":[]}',
  audience: 'everyone',
  is_published: false,
  slug: 'a-draft',
};

export const DASHBOARD_SUMMARY_RESPONSE = {
  subscribers: 2025,
  subscribersLast30Days: 77,
  totalEmail: 2020,
  arr: 120,
  arrDelta: 10,
  views: 5000,
  viewsDelta: 250,
};

export const OPEN_RATE_RESPONSE = {openRate: 0.42, openRateDiff: 0.01};
export const VIEWS_30D_RESPONSE = {views30d: 5000, viewsDelta30d: 250};

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

  function subscriberStatsHandler(responder) {
    return http.post(SUBSCRIBER_STATS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // One handler for all three statuses: the status is the last path segment, and a test that
  // cares which one was requested reads it off the recorded URL.
  function postsHandler(responder) {
    return http.get(`${POST_MANAGEMENT_URL}/:status`, async ({request, params}) => {
      await record(request);
      return responder(params.status);
    });
  }

  function draftDetailHandler(responder) {
    return http.get(`${DRAFTS_URL}/:id`, async ({request, params}) => {
      await record(request);
      return responder(params.id);
    });
  }

  function statsHandler(url, responder) {
    return http.get(url, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  const server = setupServer(
    draftsHandler(() => HttpResponse.json(DRAFT_RESPONSE, {status: 200})),
    subscriberStatsHandler(() => HttpResponse.json(SUBSCRIBER_STATS_RESPONSE, {status: 200})),
    postsHandler(() => HttpResponse.json(POSTS_RESPONSE, {status: 200})),
    draftDetailHandler(() => HttpResponse.json(DRAFT_DETAIL_RESPONSE, {status: 200})),
    statsHandler(DASHBOARD_SUMMARY_URL, () => HttpResponse.json(DASHBOARD_SUMMARY_RESPONSE, {status: 200})),
    statsHandler(OPEN_RATE_URL, () => HttpResponse.json(OPEN_RATE_RESPONSE, {status: 200})),
    statsHandler(VIEWS_30D_URL, () => HttpResponse.json(VIEWS_30D_RESPONSE, {status: 200}))
  );

  return {
    server,
    requests,
    draftsHandler,
    subscriberStatsHandler,
    postsHandler,
    draftDetailHandler,
    statsHandler,
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
