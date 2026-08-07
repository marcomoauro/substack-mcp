import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// `send` defaults to false here even though the API's own default is true. Publishing is public and
// the email is the irreversible half — once it is out it cannot be recalled — so the safe half is
// what a caller gets by omitting the argument. A model that wants the email has to ask for it.
export const publishDraftSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to publish, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  send: z
    .boolean()
    .default(false)
    .describe(
      "Whether to email the post to subscribers. Defaults to false: the post goes live on the web " +
      "either way, but an email cannot be unsent, so this must be asked for explicitly."
    ),
  share_automatically: z
    .boolean()
    .default(false)
    .describe("Whether Substack should auto-share the post to Notes on publish."),
});

export const publishDraftHandler = async (args) => {
  logger.debug('publish_draft.start', {args});

  let validatedArgs;

  try {
    validatedArgs = publishDraftSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('publish_draft.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, send, share_automatically} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Logged at info before the call, not only after: if the publish half-succeeds or the response is
  // never read, this line is the only record that something was made public and whether it mailed.
  logger.info('publish_draft.publishing', {draft_id, send, share_automatically});

  const post = await substack_api.publishDraft(draft_id, {send, share_automatically});

  logger.info('publish_draft.done', {
    draft_id,
    post_id: post?.id ?? null,
    is_published: post?.is_published ?? null,
    emailed: send,
  });

  return {
    status: 'published',
    draft_id,
    post_id: post?.id ?? null,
    title: post?.title ?? post?.draft_title ?? null,
    slug: post?.slug ?? null,
    canonical_url: post?.canonical_url ?? null,
    emailed: send,
    shared_automatically: share_automatically,
  };
};
