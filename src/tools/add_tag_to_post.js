import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Takes a tag *name*, not an id, because the ids on this endpoint are UUIDs — nothing a caller could
// hold without having listed the tags first. The name is matched case-insensitively against the
// publication's tags and, unless `create_if_missing` is off, created when it does not exist.
export const addTagToPostSchema = z.strictObject({
  post_id: z
    .number()
    .int()
    .describe("The numeric id of the post to tag, from list_posts. Works for drafts too."),
  tag_name: z
    .string()
    .min(1)
    .describe("The tag to add, by name. Matched case-insensitively against existing tags."),
  create_if_missing: z
    .boolean()
    .default(true)
    .describe(
      "Create the tag on the publication when no tag by that name exists. Set to false to fail " +
      "instead — useful when a typo should be reported rather than turned into a new tag."
    ),
});

export const addTagToPostHandler = async (args) => {
  logger.debug('add_tag_to_post.start', {args});

  let validatedArgs;

  try {
    validatedArgs = addTagToPostSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('add_tag_to_post.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {post_id, tag_name, create_if_missing} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const tags = await substack_api.getPostTags();
  const wanted = tag_name.trim().toLowerCase();
  let tag = (tags ?? []).find((candidate) => candidate?.name?.trim().toLowerCase() === wanted);
  let created = false;

  if (!tag) {
    if (!create_if_missing) {
      logger.error('add_tag_to_post.tag_missing', {tag_name, available: (tags ?? []).length});
      throw new Error(
        `No tag named "${tag_name}" exists on this publication and create_if_missing is false. ` +
        'Use list_publication_tags to see the available names.'
      );
    }

    logger.info('add_tag_to_post.creating_tag', {tag_name});
    tag = await substack_api.createPostTag(tag_name);
    created = true;
  }

  // Re-attaching a tag the post already has answers a bare 400 that names neither the post nor the
  // tag — verified. Checking first turns that into an accurate answer instead of an error that reads
  // as though the request itself was malformed.
  const existing = await substack_api.getTagsForPost(post_id);

  if ((existing ?? []).some((association) => association?.post_tag_id === tag?.id)) {
    logger.info('add_tag_to_post.already_tagged', {post_id, tag_name, post_tag_id: tag?.id});

    return {
      status: 'already_tagged',
      post_id,
      tag: {id: tag?.id ?? null, name: tag?.name ?? tag_name},
      tag_created: created,
    };
  }

  const association = await substack_api.addTagToPost(post_id, tag.id);

  logger.info('add_tag_to_post.done', {
    post_id,
    tag_name,
    post_tag_id: tag?.id,
    tag_created: created,
    association_id: association?.id ?? null,
  });

  return {
    status: 'tagged',
    post_id,
    tag: {id: tag?.id ?? null, name: tag?.name ?? tag_name},
    tag_created: created,
    association_id: association?.id ?? null,
  };
};
