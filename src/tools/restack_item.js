import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Exactly one of the two ids, enforced by the schema rather than checked in the handler: the API
// takes both keys and there is no documented behaviour for sending both, so making the pair
// unrepresentable is better than discovering what it does.
export const restackItemSchema = z.strictObject({
  post_id: z
    .number()
    .int()
    .optional()
    .describe("Restack a post, by id. Provide either post_id or comment_id, never both."),
  comment_id: z
    .number()
    .int()
    .optional()
    .describe("Restack a Note or comment, by id. Provide either post_id or comment_id, never both."),
  tab_id: z
    .string()
    .default('for-you')
    .describe("The feed tab the restack is attributed to. Defaults to 'for-you'."),
}).refine(
  (value) => (value.post_id === undefined) !== (value.comment_id === undefined),
  {message: 'Provide exactly one of post_id or comment_id'}
);

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

  const {post_id, comment_id, tab_id} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Logged before the request: a restack appears on your profile and to your followers, and this
  // server offers no way to undo one, so the log is the only record that it happened.
  logger.info('restack_item.restacking', {post_id: post_id ?? null, comment_id: comment_id ?? null, tab_id});

  const result = await substack_api.restackFeedItem({
    post_id: post_id ?? null,
    comment_id: comment_id ?? null,
    tab_id,
  });

  logger.info('restack_item.done', {
    post_id: post_id ?? null,
    comment_id: comment_id ?? null,
    restack_id: result?.id ?? null,
  });

  return {
    status: 'restacked',
    ...(post_id === undefined ? {} : {post_id}),
    ...(comment_id === undefined ? {} : {comment_id}),
    restack_id: result?.id ?? null,
  };
};
