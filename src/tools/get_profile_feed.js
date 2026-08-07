import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {summarizeFeed} from "../api/substack/feed.js";
import {logger} from "../logger.js";

// One tool rather than the two the fork had. `get_user_notes` and `get_profile_feed` read the *same*
// endpoint — `/reader/feed/profile/:userId` — and differ only in whether posts are filtered out of
// the result. Two tool entries for one endpoint make a model's choice harder, and the one that
// filtered would have looked like the way to read a profile while quietly hiding half of it.
export const getProfileFeedSchema = z.strictObject({
  user_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Whose profile to read. Defaults to SUBSTACK_USER_ID — your own. Take another user's id from " +
      "`author_user_id` on any Note returned by get_reader_feed."
    ),
  type: z
    .enum(['all', 'notes', 'posts'])
    .default('all')
    .describe(
      "Filter what the profile returns: 'notes' for the Notes they wrote, 'posts' for what they " +
      "published, 'all' (default) for both."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("How many entries to return. 1–50, defaults to 20."),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Resume from an earlier page: pass the `next_cursor` from a previous response."),
});

export const getProfileFeedHandler = async (args) => {
  logger.debug('get_profile_feed.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getProfileFeedSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_profile_feed.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {user_id, type, limit, cursor} = validatedArgs;

  // The env var is the fallback, so "my Notes" needs no argument. Read at call time, never at import.
  const resolvedUserId = user_id ?? Number(process.env.SUBSTACK_USER_ID);

  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) {
    logger.error('get_profile_feed.user_id_unresolved', {
      user_id: user_id ?? null,
      env_user_id: process.env.SUBSTACK_USER_ID ?? null,
    });

    throw new Error(
      'user_id is required when SUBSTACK_USER_ID is not set to a numeric id.'
    );
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const feed = await substack_api.getProfileFeed(resolvedUserId, {cursor: cursor ?? null, limit});

  // Filtered after summarizing, not before: the summarizer is what decides whether an entry is a
  // note or a post, and duplicating that test against the raw `item.type` here would be a second
  // place for the two to disagree.
  const summary = summarizeFeed(feed);
  const wanted = {notes: 'note', posts: 'post'}[type];
  const items = (wanted ? summary.items.filter((item) => item.type === wanted) : summary.items).slice(0, limit);

  logger.info('get_profile_feed.done', {
    user_id: resolvedUserId,
    type,
    returned: items.length,
    before_filter: summary.items.length,
  });

  return {
    user_id: resolvedUserId,
    type,
    returned: items.length,
    // A `limit` of 20 that returns 3 notes has not reached the end of the profile — it read 20
    // entries of which 3 were notes. Saying so is what stops that from reading as "wrote 3 notes".
    ...(wanted && summary.items.length !== items.length
      ? {read_from_profile: summary.items.length, note: `Filtered to ${type}; the page held ${summary.items.length} entries in total.`}
      : {}),
    ...(summary.non_content_items_skipped
      ? {non_content_items_skipped: summary.non_content_items_skipped}
      : {}),
    next_cursor: summary.next_cursor,
    items,
  };
};
