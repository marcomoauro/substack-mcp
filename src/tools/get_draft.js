import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call. A model sending `id`
// instead of `draft_id` would otherwise only be told that `draft_id` is missing.
export const getDraftSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft, as returned in the `id` field by list_posts."
    ),
});

export const getDraftHandler = async (args) => {
  logger.debug('get_draft.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly.
  let validatedArgs;

  try {
    validatedArgs = getDraftSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_draft.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Returned whole, unlike the projection list_posts applies: a caller naming one draft wants its
  // body and its settings, and there is no further call that would fetch them.
  const draft = await substack_api.getDraft(draft_id);

  logger.info('get_draft.done', {
    draft_id,
    is_published: draft?.is_published ?? null,
    has_body: Boolean(draft?.draft_body),
  });

  return draft;
};
