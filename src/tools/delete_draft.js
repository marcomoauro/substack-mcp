import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

export const deleteDraftSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to delete, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
});

export const deleteDraftHandler = async (args) => {
  logger.debug('delete_draft.start', {args});

  let validatedArgs;

  try {
    validatedArgs = deleteDraftSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('delete_draft.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // `DELETE /drafts/:id` removes published posts too — Substack stores both behind the same entity,
  // so the id of a live post is accepted here and the post is gone, silently and irreversibly. The
  // read costs one request and is the only thing standing between a mistyped id and a deleted post,
  // so this tool spends it and refuses rather than exposing that reach through a draft-shaped name.
  const draft = await substack_api.getDraft(draft_id);

  if (draft?.is_published) {
    logger.error('delete_draft.refused_published', {
      draft_id,
      title: draft?.draft_title ?? draft?.title ?? null,
    });

    throw new Error(
      `Draft ${draft_id} is a published post ("${draft?.draft_title ?? draft?.title ?? 'untitled'}"), not a draft. ` +
      'delete_draft only removes unpublished drafts. Deleting a published post is irreversible and ' +
      'is not exposed by this server — do it from the Substack dashboard if you really mean to.'
    );
  }

  await substack_api.deleteDraft(draft_id);

  logger.info('delete_draft.done', {draft_id, title: draft?.draft_title ?? null});

  return {
    status: 'deleted',
    draft_id,
    draft_title: draft?.draft_title ?? null,
  };
};
