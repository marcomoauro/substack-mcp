import {summarizeComment} from './comment.js';

/**
 * Projection for the entries of `/reader/feed` and `/reader/feed/profile/:userId`.
 *
 * `items` is heterogeneous, and only two of its three observed types carry content:
 *
 * - `comment` — a Note (or a comment surfaced into the feed), in `item.comment`
 * - `post`    — a published post, in `item.post`
 * - `userSuggestions` — a "people to follow" block with no content at all
 *
 * The third is dropped. This is the same hazard as the `label`/`add_more` entries in the
 * subscriptions list: mapping the array straight through yields entries with no id, no author and no
 * body, which read as empty content rather than as something that was never content.
 *
 * Each entry also carries a large `context` object of ranking telemetry — `model_score`,
 * `model_rank`, `scores`, `previous_impressions`. Only its `timestamp` survives here; the rest says
 * how Substack ranked the item, which is not what a caller asked for.
 */
export function summarizeFeedItem(item) {
  if (!item) return null;

  if (item.type === 'comment') {
    return {
      type: 'note',
      ...summarizeComment(item.comment),
      publication: item.publication?.name ?? null,
      // Present when the Note is a reply: the ancestors, so a feed entry reads in context rather
      // than as an answer to nothing.
      replying_to: (item.parentComments ?? []).map((parent) => ({
        id: parent?.id ?? null,
        author: parent?.name ?? null,
        body: parent?.body ?? null,
      })),
      can_reply: Boolean(item.canReply),
      surfaced_at: item.context?.timestamp ?? null,
    };
  }

  if (item.type === 'post') {
    const post = item.post ?? {};

    return {
      type: 'post',
      id: post.id ?? null,
      title: post.title ?? null,
      subtitle: post.subtitle ?? null,
      author: (post.publishedBylines ?? []).map((byline) => byline?.name).filter(Boolean).join(', ') || null,
      publication: item.publication?.name ?? null,
      publication_id: post.publication_id ?? null,
      published_at: post.post_date ?? null,
      url: post.canonical_url ?? null,
      audience: post.audience ?? null,
      reactions: post.reaction_count ?? 0,
      comments: post.comment_count ?? 0,
      restacks: post.restacks ?? 0,
      // The teaser, never the body: a feed of 20 posts carrying `body_html` runs to hundreds of KB.
      preview_text: post.truncated_body_text ?? null,
      surfaced_at: item.context?.timestamp ?? null,
    };
  }

  // userSuggestions, and anything Substack adds later. Returning null rather than a half-empty
  // object means the caller's filter(Boolean) drops it, and a new content type shows up as a
  // missing item rather than as a nameless one.
  return null;
}

/**
 * Summarizes a whole feed response, reporting how many entries were dropped for carrying no content.
 *
 * The count matters: without it, a page whose entries were mostly `userSuggestions` looks like a
 * nearly empty feed rather than a page that had little content on it.
 */
export function summarizeFeed(payload, {limit} = {}) {
  const raw = payload?.items ?? [];
  const items = raw.map(summarizeFeedItem).filter(Boolean);
  const trimmed = typeof limit === 'number' ? items.slice(0, limit) : items;

  return {
    returned: trimmed.length,
    ...(raw.length - items.length ? {non_content_items_skipped: raw.length - items.length} : {}),
    next_cursor: payload?.nextCursor ?? null,
    items: trimmed,
  };
}
