import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Notes only. The fork this was ported from also offered `post_id`, but a published post from the
// caller's own publication answers `404 "Post da Restack non trovato"` — measured — so whatever that
// path wants is not an id from `list_posts`. A parameter that 404s on a valid id is worse than an
// absent one: the caller reads it as the post being gone rather than as the tool being wrong.
export const restackItemSchema = z.strictObject({
  comment_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the Note to restack, from get_reader_feed or get_profile_feed. Without the " +
      "`c-` prefix Substack uses in its urls."
    ),
  tab_id: z
    .string()
    .default('for-you')
    .describe("The feed tab the restack is attributed to. Defaults to 'for-you'."),
});

export const restackItemHandler = async (args) => {
  logger.debug('restack_item.start', {args});

  let validatedArgs;

  try {
    validatedArgs = restackItemSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('restack_item.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {comment_id, tab_id} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Logged before the request. A restack appears on your profile and to your followers, and it cannot
  // be undone from here — it has no id of its own, so there is nothing to delete — which makes this
  // line the only record that it happened and of what.
  logger.info('restack_item.restacking', {comment_id, tab_id});

  const result = await substack_api.restackNote(comment_id, {tab_id});

  logger.info('restack_item.done', {comment_id, restack_id: result?.id ?? null});

  return {
    status: 'restacked',
    comment_id,
    restack_id: result?.id ?? null,
    note: 'A restack cannot be undone through this server; remove it from the Substack UI.',
  };
};
