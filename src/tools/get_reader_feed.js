import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {summarizeFeed} from "../api/substack/feed.js";
import {logger} from "../logger.js";

export const getReaderFeedSchema = z.strictObject({
  tab: z
    .string()
    .default('for-you')
    .describe(
      "Which feed to read, by tab **id** — 'for-you' (default) or 'subscribed'. Set include_tabs to " +
      "see the ids available. Use the id, never the display name: the names are localized."
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
  include_tabs: z
    .boolean()
    .default(false)
    .describe("Also return the list of available feed tabs, with their ids. Defaults to false."),
});

export const getReaderFeedHandler = async (args) => {
  logger.debug('get_reader_feed.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getReaderFeedSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_reader_feed.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {tab, limit, cursor, include_tabs} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const [feed, tabs] = await Promise.all([
    substack_api.getReaderFeed({tab, cursor: cursor ?? null, limit}),
    include_tabs ? substack_api.getReaderFeedTabs() : Promise.resolve(null),
  ]);

  const summary = summarizeFeed(feed, {limit});

  logger.info('get_reader_feed.done', {
    tab,
    returned: summary.returned,
    skipped: summary.non_content_items_skipped ?? 0,
    has_cursor: Boolean(summary.next_cursor),
  });

  return {
    tab,
    ...summary,
    // `name` is localized, so it is returned for display only — `id` is what goes back into `tab`.
    ...(tabs
      ? {
          available_tabs: (tabs?.tabs ?? []).map((entry) => ({
            id: entry?.id ?? null,
            name: entry?.name ?? null,
            type: entry?.type ?? null,
          })),
        }
      : {}),
  };
};
