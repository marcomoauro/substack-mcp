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
export const SUBSCRIBER_SET_URL = `${API}/subscriber_set`;
export const SUBSCRIBER_SET_EXPORT_URL = `${API}/subscriber_set/export`;

export const SUBSCRIBER_SET_ID = 1135508;
export const EXPORT_ID = 'test-export-id';

// The export answers with a *relative* url on the publication host, cookie-authenticated — not a
// pre-signed one. Verified against the live API: fetching it without the session cookie is a 403.
export const EXPORT_FILE_PATH = `/api/v1/subscriber_set/export/${EXPORT_ID}/subscribers.csv`;
export const EXPORT_FILE_URL = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}${EXPORT_FILE_PATH}`;

/**
 * A CSV shaped exactly like a real export: the header carries human LABELS rather than column keys,
 * the server's own column order (not the requested one), a quoted currency value instead of a
 * number, and a name containing a comma — the case a `split(',')` gets wrong.
 */
export const EXPORT_CSV = [
  'Email,Name,Start date,Emails opened (30d),Post views,Revenue,Activity,Country',
  'one@example.com,One,2026-07-29T22:07:50.299Z,2,1,"€0.00",5,BR',
  'two@example.com,"Two, Junior",2026-06-01T10:00:00.000Z,0,7,"€50.00",3,IT',
].join('\n');

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

export const PUBLICATION_STATS_URL = `${API}/publication/stats`;
export const EMAIL_STATS_URL = `${API}/publication/stats/email_stats`;

/**
 * Shaped after a real response: `email_stats` is the per-post table, not an aggregate, and `total`
 * is the whole archive rather than the page. Ordered by `signups` descending here, which is what the
 * live API actually returns for that sort.
 */
export const POST_STATS_RESPONSE = {
  total: 863,
  rows: [
    {
      post_id: 163262717,
      title: 'MCP Server for Substack',
      post_date: '2026-05-08T09:00:00.000Z',
      audience: 'everyone',
      type: 'newsletter',
      sent: 1900,
      delivered: 1880,
      opens: 800,
      open_rate: 0.42,
      clicks: 120,
      click_through_rate: 0.06,
      signups: 42,
      subscribes: 6,
      estimated_value: 669.5023091726059,
      unsubscribes: 1,
      views: 3100,
      likes: 30,
      restacks: 4,
      subscribers_finished_post: 610,
      section_name: null,
      tags: [],
      bylines: [{id: 12345}],
    },
    {
      post_id: 163262700,
      title: 'How to Summarize Youtube Video using AI',
      post_date: '2026-04-02T09:00:00.000Z',
      audience: 'everyone',
      type: 'newsletter',
      sent: 1500,
      delivered: 1490,
      opens: 500,
      open_rate: 0.33,
      clicks: 60,
      click_through_rate: 0.04,
      signups: 27,
      subscribes: 2,
      estimated_value: 210.25,
      unsubscribes: 3,
      views: 5195,
      likes: 12,
      restacks: 1,
      subscribers_finished_post: 300,
      section_name: null,
      tags: [],
      bylines: [{id: 12345}],
    },
  ],
};

// One payload for every analytics report: the tool passes the body through untouched, so what it is
// matters far less than which path was asked for and with which parameters.
export const ANALYTICS_RESPONSE = {rows: [{label: 'a', value: 1}], total: 1};

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

  function postStatsHandler(responder) {
    return http.get(EMAIL_STATS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // A catch-all for the analytics reports: their paths are two and three segments deep, so `*`
  // matches any of them. Registered last so the narrower stats handlers above still win.
  function analyticsHandler(responder) {
    return http.get(`${PUBLICATION_STATS_URL}/*`, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function subscriberSetHandler(responder) {
    return http.post(SUBSCRIBER_SET_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function exportRequestHandler(responder) {
    return http.post(SUBSCRIBER_SET_EXPORT_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // Polling: `attempt` counts how many times the status has been asked for, so a test can make the
  // export become ready only on the Nth poll.
  let exportPolls = 0;

  function exportStatusHandler(responder) {
    return http.get(`${SUBSCRIBER_SET_EXPORT_URL}/:exportId`, async ({request, params}) => {
      await record(request);
      exportPolls += 1;
      return responder(params.exportId, exportPolls);
    });
  }

  function exportFileHandler(responder) {
    return http.get(`${SUBSCRIBER_SET_EXPORT_URL}/:exportId/:file`, async ({request}) => {
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
    statsHandler(VIEWS_30D_URL, () => HttpResponse.json(VIEWS_30D_RESPONSE, {status: 200})),
    postStatsHandler(() => HttpResponse.json(POST_STATS_RESPONSE, {status: 200})),
    subscriberSetHandler(() => HttpResponse.json({id: SUBSCRIBER_SET_ID}, {status: 200})),
    exportRequestHandler(() => HttpResponse.json({export_id: EXPORT_ID}, {status: 200})),
    // Ready on the first poll by default; a test that cares about the wait overrides this.
    exportStatusHandler(() => HttpResponse.json({url: EXPORT_FILE_PATH}, {status: 200})),
    exportFileHandler(() => new HttpResponse(EXPORT_CSV, {
      status: 200,
      headers: {'Content-Type': 'text/csv'},
    })),
    // Last on purpose: MSW resolves in registration order, so the two narrower
    // /publication/stats/... handlers above keep their own payloads and this catches the rest.
    analyticsHandler(() => HttpResponse.json(ANALYTICS_RESPONSE, {status: 200}))
  );

  return {
    server,
    requests,
    draftsHandler,
    subscriberStatsHandler,
    postsHandler,
    draftDetailHandler,
    statsHandler,
    postStatsHandler,
    analyticsHandler,
    subscriberSetHandler,
    exportRequestHandler,
    exportStatusHandler,
    exportFileHandler,
    start() {
      server.listen({onUnhandledRequest: 'error'});
    },
    reset() {
      server.resetHandlers();
      requests.length = 0;
      exportPolls = 0;
    },
    stop() {
      server.close();
    },
  };
}
