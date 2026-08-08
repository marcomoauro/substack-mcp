import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";
import {setPostBodySchema, setPostBodyHandler} from "./tools/set_post_body.js";
import {listSubscribersSchema, listSubscribersHandler} from "./tools/list_subscribers.js";
import {exportSubscribersSchema, exportSubscribersHandler} from "./tools/export_subscribers.js";
import {listPostsSchema, listPostsHandler} from "./tools/list_posts.js";
import {getDraftSchema, getDraftHandler} from "./tools/get_draft.js";
import {getPublicationStatsSchema, getPublicationStatsHandler} from "./tools/get_publication_stats.js";
import {getAnalyticsSchema, getAnalyticsHandler} from "./tools/get_analytics.js";
import {getPostStatsSchema, getPostStatsHandler} from "./tools/get_post_stats.js";
import {updateDraftSchema, updateDraftHandler} from "./tools/update_draft.js";
import {deleteDraftSchema, deleteDraftHandler} from "./tools/delete_draft.js";
import {publishDraftSchema, publishDraftHandler} from "./tools/publish_draft.js";
import {getPublicationSchema, getPublicationHandler} from "./tools/get_publication.js";
import {getUserProfileSchema, getUserProfileHandler} from "./tools/get_user_profile.js";
import {listPublicationTagsSchema, listPublicationTagsHandler} from "./tools/list_publication_tags.js";
import {getPostTagsSchema, getPostTagsHandler} from "./tools/get_post_tags.js";
import {addTagToPostSchema, addTagToPostHandler} from "./tools/add_tag_to_post.js";
import {getPostCommentsSchema, getPostCommentsHandler} from "./tools/get_post_comments.js";
import {commentOnPostSchema, commentOnPostHandler} from "./tools/comment_on_post.js";
import {listSubscriptionsSchema, listSubscriptionsHandler} from "./tools/list_subscriptions.js";
import {listReaderPostsSchema, listReaderPostsHandler} from "./tools/list_reader_posts.js";
import {getReaderPostSchema, getReaderPostHandler} from "./tools/get_reader_post.js";
import {getReaderFeedSchema, getReaderFeedHandler} from "./tools/get_reader_feed.js";
import {getProfileFeedSchema, getProfileFeedHandler} from "./tools/get_profile_feed.js";
import {getCommentThreadSchema, getCommentThreadHandler} from "./tools/get_comment_thread.js";
import {restackItemSchema, restackItemHandler} from "./tools/restack_item.js";
import {logger} from "./logger.js";

export const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
  },
  set_post_body: {
    // This is the only tool that publishes the document schema, and the description points at it
    // rather than restating the node list: the schema is the vocabulary, and a summary here would be
    // a second copy of it that can drift.
    description:
      "replace the body of a draft with a Substack document. This is the only way to write " +
      "structured content — headings, lists, links, code blocks, images, buttons and a paywall. " +
      "Create the draft first with create_draft_post, then call this with its id. The result " +
      "reports how many nodes of each type were stored, so a caller can confirm that what it " +
      "asked for is there. An image must already be hosted by Substack: this cannot upload one.",
    schema: setPostBodySchema,
    handler: setPostBodyHandler,
  },
  list_subscribers: {
    // The engagement caveat still belongs in the description: this endpoint takes the fields it
    // returns from the publication's saved Display settings and ignores a per-request column list,
    // so a caller filtering on opens and then looking for them here would conclude the data is
    // missing. It is not — export_subscribers reads it, which is what the pointer below is for.
    description:
      "List and filter the subscribers of your Substack publication. Supports the same 48 columns " +
      "and operators as the Subscribers dashboard, combined with AND, plus free-text search, " +
      "sorting and pagination. Returns `count`, the total matching the filters regardless of " +
      "`limit`, so a call with limit 1 is a cheap way to size a segment. Engagement columns " +
      "(email opens, post views, comments, shares, activity rating) can be filtered on here but " +
      "are not part of the records this tool returns — use export_subscribers to read their values.",
    schema: listSubscribersSchema,
    handler: listSubscribersHandler,
  },
  export_subscribers: {
    description:
      "Export subscribers with their full column values, including the engagement metrics " +
      "list_subscribers can filter on but not return: email opens over 7d/30d/6mo, unique emails " +
      "seen, post views, unique posts seen, comments, shares, links clicked, days active and " +
      "activity rating. Takes the same filters as list_subscribers and covers the whole matching " +
      "set — there is no paging. Substack generates the file asynchronously, so this waits for it " +
      "and returns the parsed records. Two columns cannot be exported and are reported in " +
      "`missing_columns` rather than failing: tag_ids and group_membership.",
    schema: exportSubscribersSchema,
    handler: exportSubscribersHandler,
  },
  list_posts: {
    description:
      "List the posts of your Substack publication: drafts, published posts or scheduled posts. " +
      "Supports free-text search, pagination and sort direction. Each post is returned as a " +
      "summary; use get_draft for the full content of an unpublished one.",
    schema: listPostsSchema,
    handler: listPostsHandler,
  },
  get_draft: {
    description:
      "Read one draft post of your Substack publication in full, including its body and its " +
      "audience and email settings. Take the id from list_posts or create_draft_post.",
    schema: getDraftSchema,
    handler: getDraftHandler,
  },
  update_draft: {
    description:
      "Change the title, subtitle or audience of an existing draft. The update is partial: only the " +
      "fields you pass change, everything else — including the body — is left alone. Take the id " +
      "from list_posts or create_draft_post.",
    schema: updateDraftSchema,
    handler: updateDraftHandler,
  },
  publish_draft: {
    description:
      "Publish a draft. The post goes live on the web; `send` additionally emails it to subscribers " +
      "and defaults to false, because an email cannot be recalled. Publishing cannot be undone from " +
      "this server — there is no unpublish tool.",
    schema: publishDraftSchema,
    handler: publishDraftHandler,
  },
  delete_draft: {
    description:
      "Delete an unpublished draft. Refuses if the id belongs to a published post: Substack deletes " +
      "both through the same endpoint, and removing a live post is irreversible, so that is left to " +
      "the dashboard.",
    schema: deleteDraftSchema,
    handler: deleteDraftHandler,
  },
  get_publication: {
    description:
      "Read the settings and identity of your Substack publication: name, subdomain, custom domain, " +
      "hero text, copyright, sender name, logo, plans and payment state. Returns a projection by " +
      "default; pass full: true for all 111 fields.",
    schema: getPublicationSchema,
    handler: getPublicationHandler,
  },
  get_user_profile: {
    description:
      "Read the account behind the session: id, handle, name, bio, and every publication you have a " +
      "role on. This is how to discover which publications the session can reach, beyond the one " +
      "SUBSTACK_PUBLICATION_URL points at.",
    schema: getUserProfileSchema,
    handler: getUserProfileHandler,
  },
  list_publication_tags: {
    description:
      "List every tag defined on your Substack publication, with its name, slug and whether it is " +
      "hidden. Tag ids are UUIDs, so this is how to find one — though add_tag_to_post takes a name " +
      "and does not need it.",
    schema: listPublicationTagsSchema,
    handler: listPublicationTagsHandler,
  },
  get_post_tags: {
    description:
      "List the tags on one post, by name. The underlying endpoint returns only UUIDs, so this " +
      "resolves them against the publication's tag list — it is the only way to read back what " +
      "add_tag_to_post did, since neither get_draft nor list_posts carries tags.",
    schema: getPostTagsSchema,
    handler: getPostTagsHandler,
  },
  add_tag_to_post: {
    description:
      "Add a tag to a post, by tag name, creating the tag on the publication if it does not exist " +
      "yet. Works on drafts as well as published posts. Reports `already_tagged` rather than failing " +
      "when the post already carries the tag.",
    schema: addTagToPostSchema,
    handler: addTagToPostHandler,
  },
  get_post_comments: {
    description:
      "Read the comments on one of your posts, each with its author, text, reaction and reply " +
      "counts, and its position in the thread. Comments withheld by Substack's automod are counted " +
      "separately under automod_hidden_count rather than mixed in.",
    schema: getPostCommentsSchema,
    handler: getPostCommentsHandler,
  },
  comment_on_post: {
    description:
      "Post a public comment on one of your posts, as you. This is published under your name and " +
      "this server offers no way to delete it.",
    schema: commentOnPostSchema,
    handler: commentOnPostHandler,
  },
  // The tools below read substack.com rather than the publication: they are about the account as a
  // *reader* — what it subscribes to, what is in its inbox, what is in its feed — rather than about
  // the publication it administers. Different host, different id space, genuinely different surface.
  list_subscriptions: {
    description:
      "List the Substack publications this account subscribes to, with the plan, membership state " +
      "and whether emails are on. Excludes paused and expired subscriptions unless asked otherwise. " +
      "This is what the account reads, not who reads it — for your own subscribers use list_subscribers.",
    schema: listSubscriptionsSchema,
    handler: listSubscriptionsHandler,
  },
  list_reader_posts: {
    description:
      "List recent posts from the publications this account subscribes to — the reader Inbox — with " +
      "read state and reading progress. Each post is summarised; use get_reader_post to read one.",
    schema: listReaderPostsSchema,
    handler: listReaderPostsHandler,
  },
  get_reader_post: {
    description:
      "Read one post in full, from any publication — not just your own. Returns the body as HTML " +
      "along with its author, stats and audience. This is the only way to read the text of someone " +
      "else's post.",
    schema: getReaderPostSchema,
    handler: getReaderPostHandler,
  },
  get_reader_feed: {
    description:
      "Read the Substack Notes feed: Notes and posts surfaced to this account. Pick the feed with " +
      "`tab` ('for-you' or 'subscribed'), and set include_tabs to discover the ids available.",
    schema: getReaderFeedSchema,
    handler: getReaderFeedHandler,
  },
  get_profile_feed: {
    description:
      "Read what one account has published — its Notes, its posts, or both. Defaults to your own " +
      "account, so this is how to list the Notes you have written; pass user_id for anyone else.",
    schema: getProfileFeedSchema,
    handler: getProfileFeedHandler,
  },
  get_comment_thread: {
    description:
      "Read one Note or comment together with the replies beneath it, each with its author and its " +
      "position in the thread. Take the id from get_reader_feed or get_profile_feed.",
    schema: getCommentThreadSchema,
    handler: getCommentThreadHandler,
  },
  restack_item: {
    description:
      "Restack a Note to your own followers. This is public, appears on your profile, and cannot be " +
      "undone from here — a restack has no id of its own, so there is nothing to delete. Notes only: " +
      "restacking a post is not supported, because that endpoint 404s even on a valid post id.",
    schema: restackItemSchema,
    handler: restackItemHandler,
  },
  get_publication_stats: {
    description:
      "Read the headline stats of your Substack publication: total and recent subscribers, ARR, " +
      "site views, and the 30-day email open rate. Takes no arguments. For anything deeper — " +
      "retention, churn, growth sources, referrals — use get_analytics.",
    schema: getPublicationStatsSchema,
    handler: getPublicationStatsHandler,
  },
  get_post_stats: {
    // Its own tool rather than a get_analytics report: it is the only one that returns per-entity
    // rows instead of an aggregate, it needs paging over 863 posts, and its sort key comes from its
    // own 43-field vocabulary. Folding it in would have meant a report that cannot be sorted.
    description:
      "Rank the posts of your Substack publication by any of 43 per-post metrics. This is how to " +
      "tell which post actually grew the list (signups, subscribes, free_to_paid_upgrades), which " +
      "was worth most (estimated_value), which cost you subscribers (unsubscribes), and which " +
      "people read to the end (subscribers_finished_post) — alongside delivery, opens, clicks, " +
      "views and restacks. Covers the whole archive with paging. There is no date filter: the " +
      "endpoint ignores one, so narrow by sorting and paging instead.",
    schema: getPostStatsSchema,
    handler: getPostStatsHandler,
  },
  get_analytics: {
    // One tool with a report enum rather than sixteen tools: the reports differ only in their
    // path and a couple of parameters, and sixteen near-identical entries in tools/list would
    // make the choice harder for a model rather than easier. Per-post numbers are the exception and
    // live in get_post_stats — they are rows, not aggregates, and need their own sort and paging.
    description:
      "Read one publication-level analytics report, covering the dashboard's Stats tabs: cohort " +
      "retention, unsubscribes and their reasons, growth sources, referrals, audience overlap with " +
      "other Substacks, subscriber Notes, paid growth, and timeseries for subscribers, followers " +
      "and ARR. For per-post numbers use get_post_stats instead. Pick a report with `report`; the ones " +
      "covering a period accept from_date and to_date and otherwise default to the last 30 days.",
    schema: getAnalyticsSchema,
    handler: getAnalyticsHandler,
  },
};

export function createServer() {
  // McpServer derives tools/list from what is registered here and validates every call
  // against the tool's zod schema before the handler runs, so there is no hand-written
  // list_tools handler, dispatch table or JSON Schema conversion to keep in sync.
  // Capabilities are derived too: the server no longer advertises `resources` and
  // `logging`, which it never implemented.
  const server = new McpServer({name: "Substack MCP", version: "1.0.0"});

  for (const [name, {description, schema, handler}] of Object.entries(tools)) {
    server.registerTool(name, {description, inputSchema: schema}, async (args) => {
      const startedAt = Date.now();
      logger.info("tool.call.start", {tool: name, args});

      try {
        const result = await handler(args);
        logger.info("tool.call.success", {tool: name, duration_ms: Date.now() - startedAt, result});

        return {content: [{type: "text", text: JSON.stringify(result, null, 2)}]};
      } catch (error) {
        // Logged and rethrown, not swallowed: McpServer still turns it into a CallToolResult
        // with isError: true, which is the shape the spec prescribes. Without this the stack
        // trace surfaces nowhere — the client only ever sees the message.
        logger.error("tool.call.error", {tool: name, duration_ms: Date.now() - startedAt, error});
        throw error;
      }
    });

    logger.info("tool.registered", {tool: name, description});
  }

  return server;
}
