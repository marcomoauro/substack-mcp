import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {summarizeNodes} from "../api/substack/document.js";
import {markdownToDoc} from "../api/substack/markdown.js";
import {logger} from "../logger.js";

// A second way into the same write set_post_body makes, for the part of a post Markdown can express.
// It is a separate tool rather than a `markdown` alternative on set_post_body so that neither contract
// bends: set_post_body keeps exactly `{draft_id, body}`, and this schema stays a single string — it
// publishes in well under a kilobyte, against the ~21 KB of the document schema, which is the cost
// the first Markdown design was measured against.
export const setPostBodyFromMarkdownSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to write, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  markdown: z
    .string()
    .describe(
      "The post body in Markdown: headings, paragraphs, **bold**, *italic*, ~~strikethrough~~, `code`, " +
      "links, bulleted and numbered lists, quotes, fenced code blocks, --- dividers, and images on a line " +
      "of their own whose url is already hosted by Substack (use upload_image first). Anything else — a " +
      "table, raw HTML, an external image — is an error and nothing is written. Markdown has no paywall, " +
      "button, caption or embed: for those use set_post_body."
    ),
});

export const setPostBodyFromMarkdownHandler = async (args) => {
  logger.debug('set_post_body_from_markdown.start', {args});

  let validatedArgs;

  try {
    validatedArgs = setPostBodyFromMarkdownSchema.parse(args);
  } catch (error) {
    logger.error('set_post_body_from_markdown.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, markdown} = validatedArgs;

  let body;

  try {
    body = markdownToDoc(markdown);
  } catch (error) {
    // Refused before any request: a conversion that would lose content writes nothing.
    logger.error('set_post_body_from_markdown.unconvertible', {draft_id, problems: error.problems ?? error.message});
    throw error;
  }

  const nodes = summarizeNodes(body);

  // Logged before the request, as set_post_body does: this replaces a body outright, and the one it
  // replaces is not recoverable from anywhere in this server.
  logger.info('set_post_body_from_markdown.writing', {draft_id, nodes});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  await substack_api.updateDraft(draft_id, {draft_body: JSON.stringify(body)});

  logger.info('set_post_body_from_markdown.done', {draft_id, nodes});

  // The tally, for the same reason set_post_body returns it: a missing paywall is valid Markdown, so
  // being told what landed is the only way a caller can notice one was never there.
  return {draft_id, nodes};
};
