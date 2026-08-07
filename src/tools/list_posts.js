import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

/**
 * The sort each status is listed by in the dashboard.
 *
 * `order_by` is not optional on the API side: `/post_management/scheduled` answers 400 when it is
 * missing, which is how the dashboard's own first request for that tab fails. Every status
 * therefore gets a default here rather than relying on the server to pick one.
 *
 * `scheduled` is also the one status whose useful order is ascending — the post going out next
 * belongs at the top, while for drafts and published posts the most recent one does.
 */
const SORT_BY_STATUS = {
  drafts: {order_by: 'draft_updated_at', order_direction: 'desc'},
  published: {order_by: 'post_date', order_direction: 'desc'},
  scheduled: {order_by: 'trigger_at', order_direction: 'asc'},
};

// A raw post carries tens of fields — bylines, per-reaction counts, headline tests, exclusion
// lists — that are noise when listing. These are the ones kept; the schema description says so,
// so a caller missing a field knows to reach for get_draft rather than assuming it does not exist.
const PROJECTED_FIELDS = [
  'id',
  'uuid',
  'type',
  'title',
  'draft_title',
  'subtitle',
  'draft_subtitle',
  'slug',
  'audience',
  'is_published',
  'post_date',
  'trigger_at',
  'draft_created_at',
  'draft_updated_at',
  'email_sent_at',
  'should_send_email',
  'section_id',
  'section_name',
  'draft_section_name',
  'cover_image',
  'reaction_count',
  'comment_count',
  'stats',
];

function project(post) {
  const projected = {};

  for (const field of PROJECTED_FIELDS) {
    if (post[field] !== undefined) projected[field] = post[field];
  }

  return projected;
}

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call.
export const listPostsSchema = z.strictObject({
  status: z
    .enum(['drafts', 'published', 'scheduled'])
    .describe(
      "Which list to read: 'drafts' for unpublished work in progress, 'published' for posts already out, 'scheduled' for posts queued to go out later."
    ),
  search: z
    .string()
    .optional()
    .describe("Free-text search over the posts, matching title and content."),
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
  sort_direction: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      "Overrides the default order. Drafts and published posts are newest-first; scheduled posts are soonest-first. The column sorted on is fixed per status: draft_updated_at, post_date and trigger_at respectively."
    ),
});

export const listPostsHandler = async (args) => {
  logger.debug('list_posts.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly.
  let validatedArgs;

  try {
    validatedArgs = listPostsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('list_posts.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {status, search = null, limit = 25, offset = 0, sort_direction = null} = validatedArgs;

  const defaults = SORT_BY_STATUS[status];
  const order_by = defaults.order_by;
  const order_direction = sort_direction ?? defaults.order_direction;

  // The caller never sees which sort was applied, and the wrong one looks like missing data
  // rather than a different order.
  logger.debug('list_posts.sort', {status, order_by, order_direction});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const response = await substack_api.getPosts({
    status,
    limit,
    offset,
    order_by,
    order_direction,
    query: search,
  });

  const posts = response?.posts ?? [];

  logger.info('list_posts.done', {
    status,
    total: response?.total ?? null,
    returned: posts.length,
    limit,
    offset,
  });

  return {
    status,
    total: response?.total ?? null,
    returned: posts.length,
    limit,
    offset,
    posts: posts.map(project),
  };
};
