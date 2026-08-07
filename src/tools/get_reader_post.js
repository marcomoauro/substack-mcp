import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

export const getReaderPostSchema = z.strictObject({
  post_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the post, from list_reader_posts or get_reader_feed. Works for posts from " +
      "any publication, not only your own."
    ),
  include_body: z
    .boolean()
    .default(true)
    .describe(
      "Include the post body as HTML. Defaults to true — reading the post is usually the point — " +
      "but a full body runs to tens of KB, so set it to false when only the metadata is wanted."
    ),
});

export const getReaderPostHandler = async (args) => {
  logger.debug('get_reader_post.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getReaderPostSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_reader_post.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {post_id, include_body} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const {post, publication} = (await substack_api.getPostById(post_id)) ?? {};

  if (!post?.id) {
    logger.error('get_reader_post.not_found', {post_id});
    throw new Error(`Substack post ${post_id} was not found, or the session cannot read it.`);
  }

  logger.info('get_reader_post.done', {
    post_id,
    publication: publication?.subdomain ?? null,
    audience: post.audience ?? null,
    include_body,
    body_length: post.body_html?.length ?? 0,
  });

  return {
    id: post.id,
    title: post.title ?? null,
    subtitle: post.subtitle ?? null,
    author: (post.publishedBylines ?? []).map((byline) => byline?.name).filter(Boolean).join(', ') || null,
    publication: publication?.name ?? null,
    publication_id: publication?.id ?? null,
    published_at: post.post_date ?? null,
    url: post.canonical_url ?? null,
    audience: post.audience ?? null,
    wordcount: post.wordcount ?? null,
    reactions: post.reaction_count ?? 0,
    comments: post.comment_count ?? 0,
    restacks: post.restacks ?? 0,
    // Left as HTML on purpose. Converting would mean either a new dependency or a regex pass over
    // markup, and a regex HTML converter mangles nested lists and embeds *silently* — the failure
    // mode this codebase avoids everywhere else. An LLM reads HTML perfectly well.
    ...(include_body ? {body_html: post.body_html ?? null} : {}),
    // Always present, even when the body is not: a paywalled post the session cannot read in full
    // still answers with its teaser here, which is the difference between "empty" and "locked".
    preview_text: post.truncated_body_text ?? null,
    // True when the body came back empty but a preview did — the post is behind a paywall this
    // session does not clear.
    body_truncated: include_body ? Boolean(!post.body_html && post.truncated_body_text) : null,
  };
};
