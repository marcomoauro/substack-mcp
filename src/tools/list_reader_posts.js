import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

export const listReaderPostsSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("How many posts to return. 1–100, defaults to 20."),
  after: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Resume from an earlier page: pass the `next_after` value from a previous response. This is a " +
      "timestamp, not an opaque cursor."
    ),
});

export const listReaderPostsHandler = async (args) => {
  logger.debug('list_reader_posts.start', {args});

  let validatedArgs;

  try {
    validatedArgs = listReaderPostsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('list_reader_posts.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {limit, after} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const page = await substack_api.listReaderPosts({limit, after: after ?? null});

  // The Inbox sends each post whole — `body_html`, `body_json` and a further 70-odd fields per
  // entry. A page of 20 is hundreds of KB, nearly all of it content nobody asked to read yet, so the
  // listing is projected and `get_reader_post` is the way to actually open one.
  const publications = new Map(
    (page?.publications ?? []).filter((publication) => publication?.id).map((publication) => [Number(publication.id), publication])
  );

  const posts = (page?.posts ?? []).map((post) => {
    const publication = publications.get(Number(post?.publication_id)) ?? {};

    return {
      id: post?.id ?? null,
      title: post?.title ?? null,
      subtitle: post?.subtitle ?? null,
      publication: publication.name ?? null,
      publication_id: post?.publication_id ?? null,
      author: (post?.publishedBylines ?? []).map((byline) => byline?.name).filter(Boolean).join(', ') || null,
      published_at: post?.post_date ?? null,
      audience: post?.audience ?? null,
      type: post?.type ?? null,
      url: post?.canonical_url ?? null,
      wordcount: post?.wordcount ?? null,
      reactions: post?.reaction_count ?? 0,
      comments: post?.comment_count ?? 0,
      restacks: post?.restacks ?? 0,
      // Reading state, which is the reason to look at an inbox rather than an archive.
      is_read: Boolean(post?.is_viewed),
      read_progress: post?.read_progress ?? null,
      is_saved: Boolean(post?.is_saved),
    };
  });

  // Paging here is a timestamp, not the `cursor` the rest of this API uses — the top-level `cursor`
  // is null on this endpoint. The value is the `content_date` of the last inbox entry.
  const nextAfter = (page?.inboxItems ?? []).at(-1)?.content_date ?? null;
  const hasMore = Boolean(page?.more && nextAfter);

  logger.info('list_reader_posts.done', {
    returned: posts.length,
    more: hasMore,
    next_after: nextAfter,
  });

  return {
    returned: posts.length,
    more: hasMore,
    ...(hasMore ? {next_after: nextAfter} : {}),
    posts,
  };
};
