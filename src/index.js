#!/usr/bin/env node

import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createServer} from "./server.js";

// check envs
if (!process.env.SUBSTACK_PUBLICATION_URL || !process.env.SUBSTACK_SESSION_TOKEN || !process.env.SUBSTACK_USER_ID) {
  throw new Error("SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set");
}

const server = createServer();

const transport = new StdioServerTransport();
server.connect(transport).catch(() => {
  process.exit(1);
});
