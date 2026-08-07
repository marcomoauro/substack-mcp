/**
 * Projection for Substack's `comment` entity.
 *
 * Comments and Notes are the *same* entity: a Note is a comment with `type: 'feed'` and no
 * `post_id`, a post comment is one carrying the post it belongs to. So one summarizer serves the
 * post-comment tools and the Notes/feed tools alike, and there is no second shape to keep in sync.
 *
 * Every field below was read off a live response. Three of them are easy to get wrong by analogy
 * with the rest of this API, and were wrong in the fork this was ported from:
 *
 * - The author is flat — `name`, `handle`, `photo_url` sit on the comment itself. There is no
 *   nested `user` object to read through.
 * - Replies are counted by `children_count`. There is no `children` array to take `.length` of.
 * - There is no `parent_id`. Hierarchy is a materialized path in `ancestor_path`.
 */

/**
 * `ancestor_path` is a dot-separated chain of ancestor ids, root-first, and empty for a top-level
 * comment. Verified across three depths: `''`, then `'309007328'`, then `'309007328.309403526'`.
 * The parent is therefore the last segment, not the first — reading it as a single id works only
 * until the thread is three deep.
 */
export function parseAncestorPath(ancestor_path) {
  if (typeof ancestor_path !== 'string' || ancestor_path === '') {
    return {parent_comment_id: null, depth: 0};
  }

  const segments = ancestor_path.split('.').filter(Boolean);
  const parent = segments.at(-1);
  const parsed = Number(parent);

  return {
    parent_comment_id: Number.isFinite(parsed) ? parsed : null,
    depth: segments.length,
  };
}

export function summarizeComment(comment) {
  if (!comment) return null;

  const {parent_comment_id, depth} = parseAncestorPath(comment.ancestor_path);

  return {
    id: comment.id ?? null,
    author: comment.name ?? null,
    author_handle: comment.handle ?? null,
    author_user_id: comment.user_id ?? null,
    // Plain text, sent alongside the ProseMirror `body_json`. Using it means no document to walk:
    // the API already did that. `body_json` is deliberately dropped — it is several times the size
    // and says nothing `body` does not.
    body: comment.body ?? null,
    date: comment.date ?? null,
    edited_at: comment.edited_at ?? null,
    // Two shapes exist, both verified. Reads and feed entries carry the counts (`reaction_count`,
    // `children_count`); the response to *creating* a comment carries the collections instead
    // (`reactions` as an object, `children` as an array) and no counts at all. Both are handled
    // because the create path runs through this same summarizer.
    reactions: comment.reaction_count ?? Object.keys(comment.reactions ?? {}).length,
    restacks: comment.restacks ?? 0,
    reply_count: comment.children_count ?? (comment.children ?? []).length,
    // null on a Note, set on a post comment — which is also how to tell the two apart.
    post_id: comment.post_id ?? null,
    publication_id: comment.publication_id ?? null,
    parent_comment_id,
    depth,
    attachment_count: (comment.attachments ?? []).length,
  };
}
