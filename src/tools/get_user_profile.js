import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// This is the one call that answers "who am I and what do I have access to" — the `publicationUsers`
// list names every publication with your role on it, which is how a caller learns that
// SUBSTACK_PUBLICATION_URL is not the only publication it could be pointed at.
//
// Projected by default for the same reason as get_publication: the raw payload carries the full
// `subscriptions` array, which grows with every publication the account reads and dwarfs the
// identity fields that were actually asked for.
export const getUserProfileSchema = z.strictObject({
  full: z
    .boolean()
    .default(false)
    .describe(
      "Return the complete payload, including the full `subscriptions` array. Defaults to false, " +
      "which returns identity plus the publications you have a role on."
    ),
});

export const getUserProfileHandler = async (args) => {
  logger.debug('get_user_profile.start', {args});

  let validatedArgs;

  try {
    validatedArgs = getUserProfileSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('get_user_profile.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {full} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const profile = await substack_api.getUserProfile();

  logger.info('get_user_profile.done', {
    user_id: profile?.id ?? null,
    handle: profile?.handle ?? null,
    full,
    publication_count: (profile?.publicationUsers ?? []).length,
  });

  if (full) return profile;

  return {
    id: profile?.id ?? null,
    name: profile?.name ?? null,
    handle: profile?.handle ?? null,
    bio: profile?.bio ?? null,
    photo_url: profile?.photo_url ?? null,
    publications: (profile?.publicationUsers ?? []).map((entry) => ({
      role: entry?.role ?? null,
      publication_id: entry?.publication?.id ?? null,
      subdomain: entry?.publication?.subdomain ?? null,
      name: entry?.publication?.name ?? null,
    })),
    primary_publication_id: profile?.primaryPublication?.id ?? null,
    subscription_count: (profile?.subscriptions ?? []).length,
    _meta: {
      projected: true,
      hint: 'Pass full: true for the complete payload, including every subscription.',
    },
  };
};
