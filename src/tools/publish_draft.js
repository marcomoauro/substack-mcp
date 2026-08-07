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

  const {draft_id, send} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // The email intent is written to the draft *before* publishing, in addition to being passed on the
  // publish call. This is not belt-and-braces for its own sake: `should_send_email` is where the
  // dashboard keeps the decision — its serializer computes `dontSendEmail` from it — and it defaults
  // to `true` on a real draft. If the publish endpoint turns out to read the draft rather than the
  // body, a request carrying only `send: false` would mail the entire list. Setting both makes the
  // two possible behaviours agree, and the failure mode of the redundant write is nothing at all.
  logger.info('publish_draft.setting_email_intent', {draft_id, should_send_email: send});
  await substack_api.updateDraft(draft_id, {should_send_email: send});

  // Logged at info before the call, not only after: if the publish half-succeeds or the response is
  // never read, this line is the only record that something was made public and whether it mailed.
  logger.info('publish_draft.publishing', {draft_id, send});

  const post = await substack_api.publishDraft(draft_id, {send});

  logger.info('publish_draft.done', {
    draft_id,
    post_id: post?.id ?? null,
    is_published: post?.is_published ?? null,
    emailed: send,
    email_sent_at: post?.email_sent_at ?? null,
  });

  return {
    status: 'published',
    draft_id,
    post_id: post?.id ?? null,
    title: post?.title ?? post?.draft_title ?? null,
    slug: post?.slug ?? null,
    canonical_url: post?.canonical_url ?? null,
    emailed: send,
    // The server's own record of whether it mailed, which is the only trustworthy answer — `emailed`
    // above is what was *asked* for.
    email_sent_at: post?.email_sent_at ?? null,
  };
};
