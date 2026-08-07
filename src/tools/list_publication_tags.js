import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

export const listPublicationTagsSchema = z.strictObject({
  include_hidden: z
    .boolean()
    .default(true)
    .describe(
      "Include tags flagged `hidden` — defined on the publication but not shown in its navigation. " +
      "Defaults to true, since a hidden tag is still usable on a post."
    ),
});

export const listPublicationTagsHandler = async (args) => {
  logger.debug('list_publication_tags.start', {args});

  let validatedArgs;

  try {
    validatedArgs = listPublicationTagsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('list_publication_tags.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {include_hidden} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const tags = await substack_api.getPostTags();
  const visible = include_hidden ? tags : tags.filter((tag) => !tag?.hidden);

  logger.info('list_publication_tags.done', {
    total: tags.length,
    returned: visible.length,
    include_hidden,
  });

  return {
    total: tags.length,
    returned: visible.length,
    // `id` is a UUID here, unlike every other id in this API. Kept because add_tag_to_post accepts
    // one, but that tool takes a name too — which is the reason it does, since a UUID is not
    // something a caller can reasonably be expected to have.
    tags: visible.map((tag) => ({
      id: tag?.id ?? null,
      name: tag?.name ?? null,
      slug: tag?.slug ?? null,
      hidden: Boolean(tag?.hidden),
    })),
  };
};
