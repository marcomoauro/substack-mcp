import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";

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
    server.registerTool(name, {description, inputSchema: schema}, async (args) => ({
      content: [{type: "text", text: JSON.stringify(await handler(args), null, 2)}],
    }));
  }

  return server;
}
