import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";
import {logger} from "./logger.js";

export const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
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
