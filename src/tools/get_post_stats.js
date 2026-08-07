import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

/**
 * The 43 fields `GET /publication/stats/email_stats` returns for each post, read off a real response.
 *
 * Despite its name that endpoint is not an aggregate email report: it is the per-post table behind
 * the dashboard's "Posts" tab (which lives at /publish/stats/emails), one row per post across the
 * whole archive, paginated and sortable.
 *
 * Every field is offered as a sort key, and that enum is load-bearing rather than cosmetic: the API
 * answers **200 for an order_by it does not recognise** and returns an arbitrary order. A typo would
 * otherwise yield a ranking that looks authoritative and means nothing.
 */
export const POST_STAT_FIELDS = [
  // Identity
  'post_id',
  'title',
  'post_date',
  'audience',
  'type',
  'section_id',
  'section_name',
  'tags',
  'bylines',

  // Delivery
  'queued',
  'sent',
  'delivered',
  'dropped',

  // Reading
  'opens',
  'opened',
  'open_rate',
  'clicks',
  'clicked',
  'click_through_rate',
  'views',
  'subscribers_finished_post',

  // Conversion — what a post was actually worth
  'signups',
  'subscribes',
  'founding_subscribes',
  'annual_subscribes',
  'monthly_subscribes',
  'free_trials',
  'free_to_paid_upgrades',
  'signups_within_1_day',
  'subscriptions_within_1_day',
  'estimated_value',

  // Churn
  'unsubscribes',

  // Social
  'likes',
  'shares',
  'restacks',
  'engagement_rate',
  'unique_engagements',

  // Video and podcast
  'video_views',
  'video_minutes_watched',
  'downloads',
  'downloads_day30',
  'podcast_preview_downloads',
  'podcast_preview_downloads_day30',
];

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call. It also matters here for a
// second reason — `from_date` is a plausible key that this endpoint ignores, so being told it is
// unrecognised is the difference between knowing there is no date filter and believing there is one.
export const getPostStatsSchema = z.strictObject({
  order_by: z
    .enum(POST_STAT_FIELDS)
    .optional()
    .describe(
      "Which metric to rank by, defaulting to post_date. Use signups or subscribes for the posts " +
      "that grew the list, estimated_value for the most valuable, unsubscribes for the ones that " +
      "cost subscribers, subscribers_finished_post for the ones people actually read to the end."
    ),
  order_direction: z
    .enum(['asc', 'desc'])
    .optional()
    .describe("Sort direction, defaulting to desc — the highest first."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many posts to return, 1-100, defaulting to 25."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How many posts to skip, for paging through the archive."),
});

export const getPostStatsHandler = async (args) => {
  logger.debug('get_post_stats.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly.
  let validatedArgs;

  try {
    validatedArgs = getPostStatsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_post_stats.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {
    order_by = 'post_date',
    order_direction = 'desc',
    limit = 25,
    offset = 0,
  } = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // No date parameters: verified that from_date/to_date leave `total` unchanged, so the endpoint
  // ignores them. Sending them anyway would suggest a narrowing that never happens.
  const response = await substack_api.request({
    method: 'GET',
    path: '/publication/stats/email_stats',
    params: {offset, limit, order_by, order_direction},
    referer: '/publish/stats/emails',
  });

  // Returned in the order the API chose, unsorted and unfiltered by this tool. That matters for the
  // rate fields: `null` sorts before numbers, so ranking by open_rate descending puts posts with no
  // data at the top. Quietly dropping them would be inventing a different question.
  const posts = response?.rows ?? [];

  logger.info('get_post_stats.done', {
    order_by,
    order_direction,
    total: response?.total ?? null,
    returned: posts.length,
    limit,
    offset,
  });

  return {
    // The whole archive, not the page — 863 posts on the publication this was built against.
    total: response?.total ?? null,
    returned: posts.length,
    limit,
    offset,
    // Echoed so a ranking is never read without knowing what produced it.
    order_by,
    order_direction,
    posts,
  };
};
