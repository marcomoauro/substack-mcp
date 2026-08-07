import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

/**
 * The analytics reports behind the dashboard's Stats tabs, one entry per verified endpoint.
 *
 * Every one of these was called against the live API during reconnaissance and answered 200. Two
 * neighbours are deliberately absent: `audience_insights/location` and `visitor_sources` answer 400
 * even for Substack's own dashboard — observed in the page's own network log, with and without
 * parameters — so they are broken upstream rather than mis-called, and must not be added back
 * without re-checking.
 *
 * `window: 'date'` takes `from_date`/`to_date` as `YYYY-MM-DD`; `window: 'iso'` takes `start`/`end`
 * as full ISO timestamps, which is what the retention endpoint wants. `limit` is a default for the
 * reports that answer 400 without one. `params` are fixed extras the dashboard always sends.
 */
export const ANALYTICS_REPORTS = {
  email_stats: {
    path: '/publication/stats/email_stats',
    description: 'Per-email delivery and open statistics for every send.',
  },
  unsubscribes: {
    path: '/publication/stats/unsubscribes',
    window: 'date',
    description: 'Unsubscribes in a window, broken down by the reason given.',
  },
  unsubscribes_timeseries: {
    path: '/publication/stats/unsubscribes/timeseries',
    window: 'date',
    description: 'Unsubscribes over time.',
  },
  retention: {
    path: '/publication/stats/subscriber_retention',
    window: 'iso',
    params: {months: 12, is_subscribed: false},
    description: 'Cohort retention: how much of each signup cohort is still subscribed months later.',
  },
  retention_summary: {
    path: '/publication/stats/subscriber_retention/summary',
    params: {is_subscribed: false},
    description: 'Headline retention rates at 1, 6 and 12 months.',
  },
  referrals_leaderboard: {
    path: '/publication/stats/referrals/leaderboard',
    description: 'Which subscribers have referred the most readers.',
  },
  referrals_summary: {
    path: '/publication/stats/referrals/summary',
    description: 'Gifts sent, accepted and converted.',
  },
  audience_overlap: {
    path: '/publication/stats/audience_insights/overlap',
    limit: 6,
    description: 'Other Substacks whose audience overlaps yours, with the overlap percentage — the publications worth collaborating with.',
  },
  audience_locations: {
    path: '/publication/stats/audience_insights/location/total',
    description: 'How many distinct countries and US states your subscribers span.',
  },
  subscriber_notes: {
    path: '/publication/stats/subscriber_notes',
    limit: 8,
    description: 'Recent Notes written by your subscribers.',
  },
  paid_subscriber_growth: {
    path: '/publication/stats/paid_subscriber_growth/summary',
    description: 'Paid growth rate for the period, with new subscriptions and expirations.',
  },
  arr_timeseries: {
    path: '/publication/stats/arr/timeseries',
    description: 'Annual recurring revenue over time.',
  },
  followers_timeseries: {
    path: '/publication/stats/followers/timeseries',
    description: 'Follower count over time.',
  },
  subscribers_timeseries: {
    path: '/publication/stats/subscribers/timeseries',
    params: {period: 'month'},
    description: 'Subscriber count over time.',
  },
  growth_sources: {
    path: '/publication/stats/growth/sources',
    window: 'date',
    params: {order_by: 'users', order_direction: 'desc'},
    description: 'Where new subscribers came from in a window, ranked by how many each source brought.',
  },
  growth_events: {
    path: '/publication/stats/growth/events',
    window: 'date',
    description: 'The individual growth events in a window.',
  },
  network_attribution: {
    path: '/publication/stats/network_attribution',
    params: {time_window: '90 days', is_subscribed: false},
    description: 'What share of your subscribers arrived through the Substack network rather than your own channels.',
  },
};

const REPORT_NAMES = Object.keys(ANALYTICS_REPORTS);

const DEFAULT_WINDOW_DAYS = 30;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const REPORT_REFERENCE = Object.entries(ANALYTICS_REPORTS)
  .map(([name, {description}]) => `${name} — ${description}`)
  .join(' ');

const asDate = (date) => date.toISOString().slice(0, 10);

const daysBefore = (date, days) => new Date(date.getTime() - days * 86400000);

// A calendar year rather than 365 days, so a leap year does not shift the window by a day.
function yearBefore(date) {
  const shifted = new Date(date);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
  return shifted;
}

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call.
export const getAnalyticsSchema = z.strictObject({
  report: z
    .enum(REPORT_NAMES)
    .describe(`Which report to read. ${REPORT_REFERENCE}`),
  from_date: z
    .string()
    .regex(DATE_PATTERN, 'from_date must be YYYY-MM-DD')
    .optional()
    .describe(
      "Start of the window, as YYYY-MM-DD. Only used by the reports that cover a period; defaults to 30 days ago, or a year ago for retention."
    ),
  to_date: z
    .string()
    .regex(DATE_PATTERN, 'to_date must be YYYY-MM-DD')
    .optional()
    .describe("End of the window, as YYYY-MM-DD. Defaults to today."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "How many rows to return. Only used by audience_overlap and subscriber_notes, which default to 6 and 8."
    ),
});

/**
 * Works out the query string for one report, and which of the caller's parameters it could not use.
 *
 * Sending an extra parameter is not harmless here — several of these endpoints answer 400 on one —
 * so a parameter that does not apply is dropped and named rather than passed along.
 */
function resolveParams(report, {from_date, to_date, limit}, now) {
  const definition = ANALYTICS_REPORTS[report];
  const params = {...(definition.params ?? {})};
  const ignored = [];

  if (definition.window) {
    const to = to_date ?? asDate(now);
    const from = from_date ?? asDate(
      definition.window === 'iso' ? yearBefore(now) : daysBefore(now, DEFAULT_WINDOW_DAYS)
    );

    if (definition.window === 'iso') {
      // The retention endpoint takes full timestamps, not plain dates.
      params.start = `${from}T00:00:00.000Z`;
      params.end = `${to}T00:00:00.000Z`;
    } else {
      params.from_date = from;
      params.to_date = to;
    }
  } else {
    if (from_date !== undefined) ignored.push('from_date');
    if (to_date !== undefined) ignored.push('to_date');
  }

  if (definition.limit !== undefined) {
    params.limit = limit ?? definition.limit;
  } else if (limit !== undefined) {
    ignored.push('limit');
  }

  return {params, ignored};
}

export const getAnalyticsHandler = async (args, {now = () => new Date()} = {}) => {
  logger.debug('get_analytics.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly.
  let validatedArgs;

  try {
    validatedArgs = getAnalyticsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_analytics.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {report} = validatedArgs;
  const {path} = ANALYTICS_REPORTS[report];
  const {params, ignored} = resolveParams(report, validatedArgs, now());

  logger.debug('get_analytics.resolved', {report, path, params});

  // Dropping a parameter the caller believed in is the failure mode this API has already produced
  // twice — the ignored columnView, and the export's silently dropped columns — so it is said out
  // loud rather than left for the caller to notice.
  if (ignored.length > 0) {
    logger.warn('get_analytics.params.ignored', {report, ignored_params: ignored});
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const data = await substack_api.request({
    method: 'GET',
    path,
    params,
    referer: '/publish/stats',
  });

  logger.info('get_analytics.done', {report, path, params});

  return {
    report,
    // The parameters actually sent, defaults included: the same report answers very differently
    // over a different window, so the answer is meaningless without them.
    params,
    ignored_params: ignored,
    data,
  };
};
