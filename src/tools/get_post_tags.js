import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

export const getPostTagsSchema = z.strictObject({
  post_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the post, from list_posts. Works for drafts as well as published posts."
    ),
});

export const getPostTagsHandler = async (args) => {
  logger.debug('get_post_tags.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getPostTagsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_post_tags.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {post_id} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Two requests, because `/post/:id/tag` answers *join rows* — {id, publication_id, post_id,
  // post_tag_id} — and carries no name or slug. Returned raw it would hand the caller a list of
  // UUIDs it has no way to interpret, so the names are resolved against the publication's tag list
  // here rather than left as a second call the caller has to know to make.
  const [associations, tags] = await Promise.all([
    substack_api.getTagsForPost(post_id),
    substack_api.getPostTags(),
  ]);

  const tagById = new Map((tags ?? []).map((tag) => [tag?.id, tag]));

  const resolved = (associations ?? []).map((association) => {
    const tag = tagById.get(association?.post_tag_id);

    return {
      post_tag_id: association?.post_tag_id ?? null,
      name: tag?.name ?? null,
      slug: tag?.slug ?? null,
      hidden: tag ? Boolean(tag.hidden) : null,
      // The association's own UUID, distinct from post_tag_id — this is the row, not the tag.
      association_id: association?.id ?? null,
      // A tag on the post that is no longer in the publication's list: the name cannot be resolved,
      // and saying so beats returning `name: null` as though the tag were nameless.
      ...(tag ? {} : {unresolved: true}),
    };
  });

  const unresolved = resolved.filter((tag) => tag.unresolved).length;

  logger.info('get_post_tags.done', {post_id, count: resolved.length, unresolved});

  return {
    post_id,
    count: resolved.length,
    tags: resolved,
    ...(unresolved
      ? {warning: `${unresolved} tag(s) on this post are not in the publication's tag list; their names could not be resolved.`}
      : {}),
  };
};
