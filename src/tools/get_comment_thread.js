import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {summarizeComment} from "../api/substack/comment.js";
import {logger} from "../logger.js";

export const getCommentThreadSchema = z.strictObject({
  comment_id: z
    .number()
    .int()
    .describe(
      "The numeric id of a Note or comment, from get_reader_feed or get_profile_feed. Without the " +
      "`c-` prefix Substack uses in its urls."
    ),
  include_replies: z
    .boolean()
    .default(true)
    .describe("Also fetch the reply branches beneath it. Defaults to true."),
});

export const getCommentThreadHandler = async (args) => {
  logger.debug('get_comment_thread.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getCommentThreadSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_comment_thread.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {comment_id, include_replies} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const [detail, replies] = await Promise.all([
    substack_api.getComment(comment_id),
    include_replies ? substack_api.getCommentReplies(comment_id) : Promise.resolve(null),
  ]);

  // The detail endpoint wraps its payload in `item`, unlike the replies endpoint, which returns
  // `rootComment` at the top level.
  const comment = summarizeComment(detail?.item?.comment ?? detail?.item ?? null);

  if (!comment?.id) {
    logger.error('get_comment_thread.not_found', {comment_id});
    throw new Error(`Substack comment ${comment_id} was not found, or the session cannot read it.`);
  }

  // Each branch is a direct reply plus its own descendants, already flattened by the API.
  const branches = (replies?.commentBranches ?? []).map((branch) => ({
    reply: summarizeComment(branch?.comment),
    descendants: (branch?.descendantComments ?? []).map(summarizeComment).filter(Boolean),
  })).filter((branch) => branch.reply);

  const replyCount = branches.reduce((total, branch) => total + 1 + branch.descendants.length, 0);

  logger.info('get_comment_thread.done', {
    comment_id,
    branches: branches.length,
    replies_returned: replyCount,
    more_branches: Boolean(replies?.moreBranches),
  });

  return {
    comment,
    ...(include_replies
      ? {
          replies_returned: replyCount,
          branch_count: branches.length,
          // `reply_count` on the comment is the true total; this page may hold fewer.
          more_branches: Boolean(replies?.moreBranches),
          next_cursor: replies?.nextCursor ?? null,
          branches,
        }
      : {}),
  };
};
