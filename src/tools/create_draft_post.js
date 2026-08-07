import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import SubstackPost from "../api/substack/SubstackPost.js";
import {logger} from "../logger.js";


// strictObject, not object: an unknown key must be reported rather than stripped. The
// validation message is the only feedback an LLM gets to correct a malformed call, and
// silently discarding a key it believed it passed is both confusing and unsafe — a model
// sending `content` instead of `body` would otherwise only be told `body` is missing.
export const createDraftPostSchema = z.strictObject({
  title: z
    .string()
    .describe(
      "The title of the post to be created."
    ),
  subtitle: z
    .string()
    .describe(
      "The subtitle of the post to be created."
    ),
  body: z
    .string()
    .describe(
      "The body of the post to be created. Either plain text (paragraphs separated by blank lines) or a JSON string of a Substack document, e.g. {\"type\":\"doc\",\"content\":[...]}."
    ),
});

const parseBody = (body) => {
  try {
    const doc = JSON.parse(body);
    if (doc && doc.type === 'doc') {
      logger.debug('draft.body.parsed', {format: 'prosemirror', nodes: doc.content?.length ?? 0});
      return doc;
    }

    // Valid JSON that is not a document: it goes through as text, and a model that believed
    // it was sending a document would have no other way to find out.
    logger.debug('draft.body.json_is_not_a_document', {parsed: doc});
  } catch (error) {
    // not JSON, treat as plain text
  }

  const doc = {
    type: 'doc',
    content: body
      .split(/\n+/)
      .filter(paragraph => paragraph.trim() !== '')
      .map(paragraph => ({
        type: 'paragraph',
        content: [{type: 'text', text: paragraph}],
      })),
  };

  logger.debug('draft.body.parsed', {format: 'text', nodes: doc.content.length, chars: body.length});
  return doc;
};

export const createDraftPostHandler = async (args) => {
  logger.debug('create_draft_post.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this
  // parse never rejects. It is kept so the handler stays safe when called directly, which
  // is how its own tests exercise it.
  let validatedArgs;

  try {
    validatedArgs = createDraftPostSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined
    // instead of failing. Reached only on a direct call — over MCP the SDK rejects first.
    logger.error('create_draft_post.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {title, subtitle, body} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  })

  const substack_post = new SubstackPost({user_id: process.env.SUBSTACK_USER_ID});

  substack_post.setTitle(title)
  substack_post.setSubtitle(subtitle)
  substack_post.setBody(parseBody(body))

  const draft = substack_post.getDraft();
  logger.debug('create_draft_post.draft.built', {draft});

  const response = await substack_api.postDraft(draft)

  logger.info('create_draft_post.created', {
    draft_id: response?.id ?? null,
    is_published: response?.is_published ?? null,
  });

  // The id, not 'OK': it is what get_draft needs, and returning it is the only way the model can
  // reach the draft it just created — the log line above goes to stderr, where the model cannot
  // see it. `?? null` rather than leaving it undefined, which JSON.stringify would drop from the
  // result, reporting success while silently carrying no id at all.
  return {
    draft_id: response?.id ?? null,
    is_published: response?.is_published ?? false,
  }
}