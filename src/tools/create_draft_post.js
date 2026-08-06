import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import SubstackPost from "../api/substack/SubstackPost.js";


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
      return doc;
    }
  } catch (error) {
    // not JSON, treat as plain text
  }

  return {
    type: 'doc',
    content: body
      .split(/\n+/)
      .filter(paragraph => paragraph.trim() !== '')
      .map(paragraph => ({
        type: 'paragraph',
        content: [{type: 'text', text: paragraph}],
      })),
  };
};

export const createDraftPostHandler = async (args) => {
  // McpServer already validated against this schema before dispatching, so over MCP this
  // parse never rejects. It is kept so the handler stays safe when called directly, which
  // is how its own tests exercise it.
  const validatedArgs = createDraftPostSchema.parse(args);

  const {title, subtitle, body} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  })

  const substack_post = new SubstackPost({user_id: process.env.SUBSTACK_USER_ID});

  substack_post.setTitle(title)
  substack_post.setSubtitle(subtitle)
  substack_post.setBody(parseBody(body))

  await substack_api.postDraft(substack_post.getDraft())

  return 'OK'
}