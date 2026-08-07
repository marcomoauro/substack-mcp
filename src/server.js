import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";
import {listSubscribersSchema, listSubscribersHandler} from "./tools/list_subscribers.js";
import {exportSubscribersSchema, exportSubscribersHandler} from "./tools/export_subscribers.js";
import {listPostsSchema, listPostsHandler} from "./tools/list_posts.js";
import {getDraftSchema, getDraftHandler} from "./tools/get_draft.js";
import {getPublicationStatsSchema, getPublicationStatsHandler} from "./tools/get_publication_stats.js";
import {logger} from "./logger.js";

export const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
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
  get_publication_stats: {
    description:
      "Read the headline stats of your Substack publication: total and recent subscribers, ARR, " +
      "site views, and the 30-day email open rate. Takes no arguments.",
    schema: getPublicationStatsSchema,
    handler: getPublicationStatsHandler,
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
