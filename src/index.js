#!/usr/bin/env node

import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createServer} from "./server.js";
import {logger, logOutgoingMessages} from "./logger.js";

// check envs
const REQUIRED_ENV = ["SUBSTACK_PUBLICATION_URL", "SUBSTACK_SESSION_TOKEN", "SUBSTACK_USER_ID"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  // Which variable is missing is the whole diagnosis, and the thrown message cannot say —
  // clients surface it verbatim and its wording is pinned by the tests.
  logger.error("server.env.missing", {missing: missingEnv});
  throw new Error("SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set");
}

logger.info("server.starting", {
  publication_url: process.env.SUBSTACK_PUBLICATION_URL,
  user_id: process.env.SUBSTACK_USER_ID,
  log_level: process.env.SUBSTACK_MCP_LOG_LEVEL || "info",
  node: process.version,
});

const server = createServer();

const transport = logOutgoingMessages(new StdioServerTransport());
server.connect(transport).then(
  () => logger.info("server.ready", {transport: "stdio"}),
  (error) => {
    logger.error("server.connect.failed", {error});
    process.exit(1);
  }
);
