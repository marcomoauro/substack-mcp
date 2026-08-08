import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {postBodySchema, summarizeNodes} from "../api/substack/document.js";
import {logger} from "../logger.js";

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call. A model reaching for the
// wire name `draft_body` is told that key is unrecognised instead of having it silently dropped and
// then being told `body` is missing.
//
// This is the one tool that publishes the document schema. Keeping it here rather than on
// create_draft_post and update_draft both is deliberate: the schema measures 20,342 bytes, and paying
// it twice would grow tools/list by over 100% for every session, including those that never write a
// post. create_draft_post shares the same validator without publishing it, so nothing is unguarded.
export const setPostBodySchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to write, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  body: postBodySchema,
});

export const setPostBodyHandler = async (args) => {
  logger.debug('set_post_body.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse never
  // rejects. It is kept so the handler stays safe when called directly, which is how its tests run.
  let validatedArgs;

  try {
    validatedArgs = setPostBodySchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('set_post_body.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, body} = validatedArgs;
  const nodes = summarizeNodes(body);

  // Logged before the request, not only after: this replaces a body outright, and the one it replaces
  // is not recoverable from anywhere in this server.
  logger.info('set_post_body.writing', {draft_id, nodes});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // JSON.stringify, because draft_body goes on the wire as a string. Only this key is sent: PUT is
  // genuinely partial, so anything absent is left alone rather than cleared.
  await substack_api.updateDraft(draft_id, {draft_body: JSON.stringify(body)});

  logger.info('set_post_body.done', {draft_id, nodes});

  // The tally, not 'OK'. Validation cannot report a paywall that was never sent — a document without
  // one is exactly as valid as a document with one — so the only way a caller can confirm that what
  // it asked for landed is to be told what landed. The log goes to stderr, where a model cannot read
  // it, which makes the result the only channel back.
  return {draft_id, nodes};
};
