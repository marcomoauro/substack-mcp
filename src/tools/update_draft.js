import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// The API takes a partial body and leaves absent keys alone, so every field here is optional and
// only the ones provided are forwarded. `strictObject` matters more than usual on this tool: the
// wire names are `draft_title`/`draft_subtitle`, and a model reaching for the obvious `title` would
// otherwise be told nothing at all — the call would succeed and change nothing.
export const updateDraftSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to update, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  draft_title: z.string().optional().describe("New title. Omit to leave it unchanged."),
  draft_subtitle: z.string().optional().describe("New subtitle. Omit to leave it unchanged."),
  audience: z
    .enum(["everyone", "only_paid", "founding"])
    .optional()
    .describe("Who the post is for. Omit to leave it unchanged."),
});

export const updateDraftHandler = async (args) => {
  logger.debug('update_draft.start', {args});

  let validatedArgs;

  try {
    validatedArgs = updateDraftSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('update_draft.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, ...fields} = validatedArgs;

  // A PUT carrying only `{}` is a successful no-op, which reads back as "the update worked" while
  // nothing changed. Refusing here turns that into feedback the caller can act on.
  if (Object.keys(fields).length === 0) {
    logger.error('update_draft.no_fields', {draft_id});
    throw new Error(
      'No fields to update. Provide at least one of: draft_title, draft_subtitle, audience.'
    );
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const draft = await substack_api.updateDraft(draft_id, fields);

  logger.info('update_draft.done', {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
  });

  return {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
    draft_subtitle: draft?.draft_subtitle ?? null,
    audience: draft?.audience ?? null,
    is_published: draft?.is_published ?? null,
  };
};
