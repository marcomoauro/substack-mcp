import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Pages up to this many times when the caller's `limit` needs more than one request. A bound rather
// than "until the cursor runs out": a server that keeps handing back the same cursor would otherwise
// loop forever, and `truncated` in the result says when the bound was what stopped it.
const MAX_PAGES = 20;

export const listSubscriptionsSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("How many subscriptions to return. 1–500, defaults to 100."),
  active_only: z
    .boolean()
    .default(true)
    .describe(
      "Exclude paused subscriptions and ones whose paid term has expired. Defaults to true."
    ),
});

/**
 * A subscription is active unless it is paused or its term has already run out.
 *
 * `paused` comes back as `null` rather than `false` when it is not paused, so this tests for
 * truthiness rather than comparing to false. `expiry` is set even on free subscriptions — observed
 * at the year 2121 — so a present expiry is not itself evidence of a paid term.
 */
function isActive(subscription) {
  if (!subscription) return false;
  if (subscription.paused) return false;
  if (!subscription.expiry) return true;

  const expiry = new Date(subscription.expiry);

  // An unparseable date must not silently drop a real subscription.
  return Number.isNaN(expiry.getTime()) || expiry > new Date();
}

export const listSubscriptionsHandler = async (args) => {
  logger.debug('list_subscriptions.start', {args});

  let validatedArgs;

  try {
    validatedArgs = listSubscriptionsSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('list_subscriptions.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {limit, active_only} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Keyed by publication id: the same publication can appear under more than one label section
  // ("Paid" and a custom one), and a Map is what keeps it from being counted twice.
  const byPublication = new Map();
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  let skippedInactive = 0;
  let more = false;

  while (pages < MAX_PAGES && byPublication.size < limit) {
    const page = await substack_api.listSubscriptions({cursor, limit: 100});
    pages += 1;

    for (const item of page?.items ?? []) {
      // `items` mixes three types: 'subscription', 'label' (a section header like "Paid") and
      // 'add_more' (a UI affordance). Only the first has a publication attached, and reading the
      // others as subscriptions yields entries with no name and no id.
      if (item?.type !== 'subscription') continue;
      if (!item.pub?.id || !item.subscription?.id) continue;

      if (active_only && !isActive(item.subscription)) {
        skippedInactive += 1;
        continue;
      }

      const subdomain = item.pub.subdomain ?? String(item.pub.id);

      byPublication.set(Number(item.pub.id), {
        subscription_id: Number(item.subscription.id),
        publication_id: Number(item.pub.id),
        name: item.pub.name ?? subdomain,
        author: item.primaryProfile?.name ?? item.pub.author_name ?? null,
        subdomain,
        url: item.pub.custom_domain ?? item.pub.base_url ?? `https://${subdomain}.substack.com`,
        membership_state: item.subscription.membership_state ?? null,
        type: item.subscription.type ?? null,
        is_founding: Boolean(item.subscription.is_founding),
        is_favorite: Boolean(item.subscription.is_favorite),
        paused: Boolean(item.subscription.paused),
        expires_at: item.subscription.expiry ?? null,
        emails_disabled: Boolean(item.subscription.email_disabled),
      });

      if (byPublication.size >= limit) break;
    }

    cursor = page?.nextCursor ?? null;

    if (!cursor) break;

    // A repeated cursor means the server is not advancing. Stopping beats paging forever.
    if (seenCursors.has(cursor)) {
      logger.warn('list_subscriptions.cursor_repeated', {cursor, pages});
      break;
    }

    seenCursors.add(cursor);
    more = true;
  }

  const subscriptions = [...byPublication.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit);

  const truncated = pages >= MAX_PAGES && Boolean(cursor);

  logger.info('list_subscriptions.done', {
    returned: subscriptions.length,
    pages,
    active_only,
    skipped_inactive: skippedInactive,
    truncated,
  });

  return {
    returned: subscriptions.length,
    pages_fetched: pages,
    ...(active_only && skippedInactive ? {skipped_inactive: skippedInactive} : {}),
    // Never silently: a caller told only `returned` would read a capped list as the whole list.
    ...(truncated
      ? {truncated: true, note: `Stopped after ${MAX_PAGES} pages; more subscriptions exist.`}
      : {more: Boolean(cursor) && subscriptions.length >= limit}),
    subscriptions,
  };
};
