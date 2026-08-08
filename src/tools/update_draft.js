import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {fetchImageAsDataUri, defaultLookup, isSubstackHosted} from "../api/substack/image.js";
import {logger} from "../logger.js";

// The API takes a partial body and leaves absent keys alone, so every field here is optional and
// only the ones provided are forwarded. `strictObject` matters more than usual on this tool: the
// wire names are `draft_title`/`draft_subtitle`, and a model reaching for the obvious `title` would
// otherwise be told nothing at all — the call would succeed and change nothing.
//
// The nine settings below are the draft editor's whole Post settings panel, each verified writable
// on 2026-08-08 by a single-key PUT read back with a GET. Six neighbouring fields answer 200 and
// change nothing (`postSchedules`, `language`, `email_from_name`, `is_draft_hidden`,
// `ai_detection_disabled`, `free_unlock_required`) and are deliberately absent, so a caller that
// guesses one is told the key is unrecognised instead of believing the write landed.
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
    .enum(["everyone", "only_paid", "only_free", "founding"])
    .optional()
    .describe(
      "Who the post is for. `founding` is accepted by the API although the editor does not offer it. " +
        "Omit to leave it unchanged."
    ),
  write_comment_permissions: z
    .enum(["everyone", "subscribers", "only_paid", "none"])
    .optional()
    .describe(
      "Who may comment. `subscribers` means free or paid; `none` disables comments. Omit to leave it " +
        "unchanged."
    ),
  default_comment_sort: z
    .enum(["best_first", "most_recent_first", "oldest_first"])
    .optional()
    .describe("The order comments are shown in. Omit to leave it unchanged."),
  cover_image: z
    .string()
    .url()
    .optional()
    .describe(
      "The post's cover image, used for the social preview. A URL already on " +
        "substack-post-media.s3.amazonaws.com or substackcdn.com is used as-is; any other URL is " +
        "downloaded and re-hosted on Substack first, because Substack server-fetches only its own " +
        "bucket. Private, loopback and link-local hosts are refused. Max 10 MB. HEIC is not accepted. " +
        "Omit to leave it unchanged."
    ),
  social_title: z
    .string()
    .optional()
    .describe(
      "The title shown when the post is shared on other platforms. Distinct from draft_title, which " +
        "is the title on the post itself. Omit to leave it unchanged."
    ),
  description: z
    .string()
    .optional()
    .describe(
      "The description shown in the social preview. This is NOT the subtitle — draft_subtitle is the " +
        "subtitle. Omit to leave it unchanged."
    ),
  search_engine_title: z
    .string()
    .optional()
    .describe(
      "The SEO title. Substack recommends under 60 characters. Omit to leave it unchanged."
    ),
  search_engine_description: z
    .string()
    .optional()
    .describe(
      "The SEO description. Substack recommends 50-160 characters. Omit to leave it unchanged."
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "The post's URL slug, the last segment of its public address. Changing it changes the URL the " +
        "post will be published at. Omit to leave it unchanged."
    ),
});

// Derived, never a hand-written list: the message names every settable field, and at eleven of them
// a literal list rots the first time one is added.
const SETTABLE_FIELDS = Object.keys(updateDraftSchema.shape).filter((name) => name !== 'draft_id');

export const updateDraftHandler = async (args, {lookup = defaultLookup, fetchImpl = fetch} = {}) => {
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
      `No fields to update. Provide at least one of: ${SETTABLE_FIELDS.join(', ')}.`
    );
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Resolved BEFORE the PUT, and a failure here throws before the draft is touched: Substack
  // server-fetches only its own bucket, so an external url written straight to cover_image is
  // stored with a 200 and never renders. cover_image has no server-side validation at all — the
  // literal string "not-a-url-at-all" was accepted — so this is the only guard there is.
  let cover_rehosted_from = null;

  if (fields.cover_image !== undefined && !isSubstackHosted(fields.cover_image)) {
    const source = fields.cover_image;

    logger.info('update_draft.cover_image.fetching', {draft_id, url: source});
    const {image, contentType, bytes} = await fetchImageAsDataUri(source, {lookup, fetchImpl});

    // The data URI is deliberately not logged: hundreds of KB of base64 would bury the session.
    logger.info('update_draft.cover_image.uploading', {draft_id, content_type: contentType, bytes});
    // post_id is left null: `POST /api/v1/image` accepts a postId, but its effect is unconfirmed and
    // it was never measured against a draft.
    const uploaded = await substack_api.uploadImage({image, post_id: null});

    fields.cover_image = uploaded.url;
    cover_rehosted_from = source;
    logger.info('update_draft.cover_image.rehosted', {draft_id, from: source, to: uploaded.url});
  }

  const draft = await substack_api.updateDraft(draft_id, fields);

  logger.info('update_draft.done', {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
    cover_image_rehosted_from: cover_rehosted_from,
  });

  return {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
    draft_subtitle: draft?.draft_subtitle ?? null,
    audience: draft?.audience ?? null,
    is_published: draft?.is_published ?? null,
    // The value that landed, not the one that was asked for: after a re-host they differ, and the
    // caller has no other way to learn the new url.
    cover_image: fields.cover_image ?? draft?.cover_image ?? null,
    cover_image_rehosted_from: cover_rehosted_from,
  };
};
