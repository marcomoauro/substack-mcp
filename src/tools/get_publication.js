import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// `GET /publication` answers 111 fields and ~24 KB of JSON, and most of it is neither identity nor
// settings a caller asked about: dozens of `*_email_disabled` notification toggles plus long HTML
// blobs (`tos_content`, `privacy_content`, `welcome_email_content`, `subscribe_footer`). Returning
// it whole spends most of an LLM's context window on boilerplate it did not want, so the default is
// a projection and `full` is the way out. The projection is a *subset*, never a rename — every key
// below is the API's own, so anything learned here is usable against the raw payload.
const SUMMARY_FIELDS = [
  'id',
  'name',
  'subdomain',
  'custom_domain',
  'hero_text',
  'copyright',
  'email_from_name',
  'logo_url',
  'cover_photo_url',
  'author_name',
  'created_at',
  'language',
  'payments_state',
  'plans',
  'community_enabled',
  'moderation_enabled',
  'podcast_enabled',
  'is_personal_mode',
  'invite_only',
  'paused',
];

export const getPublicationSchema = z.strictObject({
  full: z
    .boolean()
    .default(false)
    .describe(
      "Return the complete payload — all 111 fields, ~24 KB, including every notification toggle " +
      "and the full HTML of the welcome email, terms and privacy pages. Defaults to false, which " +
      "returns identity and the settings that are usually the point."
    ),
});

export const getPublicationHandler = async (args) => {
  logger.debug('get_publication.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getPublicationSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_publication.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {full} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const publication = await substack_api.getPublication();

  logger.info('get_publication.done', {
    publication_id: publication?.id ?? null,
    subdomain: publication?.subdomain ?? null,
    full,
    field_count: Object.keys(publication ?? {}).length,
  });

  if (full) return publication;

  // A projected key that the API stopped sending would silently become `undefined` and vanish from
  // the result, which reads as "the publication has no name". Naming the absent ones instead keeps a
  // schema change visible — the same reason `get_analytics` reports `ignored_params`.
  const summary = {};
  const missing = [];

  for (const field of SUMMARY_FIELDS) {
    if (publication && field in publication) summary[field] = publication[field];
    else missing.push(field);
  }

  return {
    ...summary,
    _meta: {
      projected: true,
      returned_fields: Object.keys(summary).length,
      available_fields: Object.keys(publication ?? {}).length,
      ...(missing.length ? {fields_not_returned_by_api: missing} : {}),
      hint: 'Pass full: true for the complete payload.',
    },
  };
};
