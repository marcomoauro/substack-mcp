import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {createDraftPostSchema, createDraftPostHandler} from "./tools/create_draft_post.js";

export const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
  },
};

export function createServer() {
  const server = new Server({
      name: "Substack MCP",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        logging: {}
      },
    });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.entries(tools).map(([name, {description, schema}]) => ({
        name,
        description,
        // Same options the SDK's own zod-4 compat layer uses for tool input schemas.
        inputSchema: z.toJSONSchema(schema, {target: "draft-7", io: "input"}),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args} = request.params;

    try {
      if (!Object.hasOwn(tools, name)) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const result = await tools[name].handler(args);

      return {
        content: [{type: "text", text: JSON.stringify(result, null, 2)}],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid input: ${JSON.stringify(error.issues)}`);
      }
      throw error;
    }
  });

  return server;
}
