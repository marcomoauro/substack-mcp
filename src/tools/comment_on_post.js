import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {summarizeComment} from "../api/substack/comment.js";
import {logger} from "../logger.js";

export const commentOnPostSchema = z.strictObject({
  post_id: z
    .number()
    .int()
    .describe("The numeric id of one of your posts, from list_posts."),
  body: z
    .string()
    .min(1)
    .describe(
      "The comment text, as plain text. Substack converts it to its own document format server-side."
    ),
});

export const commentOnPostHandler = async (args) => {
  logger.debug('comment_on_post.start', {args});

  let validatedArgs;

  try {
    validatedArgs = commentOnPostSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('comment_on_post.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {post_id, body} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Logged before the call, at info and with the full text: this publishes something under your name
  // that this server offers no way to delete, so the log is the only record of what was said.
  logger.info('comment_on_post.posting', {post_id, body});

  const comment = await substack_api.commentOnPost(post_id, body);

  logger.info('comment_on_post.done', {post_id, comment_id: comment?.id ?? null});

  return {
    status: 'posted',
    post_id,
    comment: summarizeComment(comment),
  };
};
