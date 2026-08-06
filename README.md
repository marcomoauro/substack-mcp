# Substack MCP Server

A Model Context Protocol (MCP) Server for [Substack](https://substack.com) enabling LLM clients to interact with Substack's API for automations like creating posts, managing drafts, and more.

[![Docker Pulls](https://img.shields.io/docker/pulls/marcomoauro/substack-mcp.svg)](https://hub.docker.com/r/marcomoauro/substack-mcp)
[![npm downloads](https://img.shields.io/npm/dm/substack-mcp.svg)](https://www.npmjs.com/package/substack-mcp)

## 🛠 Available Tools

<details>
<summary><strong>create_draft_post</strong> - Create a draft post</summary>

**Inputs**:
- `title` (string): Title of the post
- `subtitle` (string): Subtitle of the post
- `body` (string): Body of the post

**Returns**: "OK" if the post was created successfully.
</details>

### 📋 Requirements

- Substack tokens, follow my [guide](https://implementing.substack.com/p/mcp-server-for-substack) to obtain them:
    - Session token
    - Publication URL
    - User ID
- An LLM client that supports Model Context Protocol (MCP), such as Claude Desktop, Cursors, or GitHub Copilot
- Docker

### 🔌 Installation

#### Introduction
The installation process is standardized across all MCP clients. It involves manually adding a configuration object to your client's MCP configuration JSON file.
> If you're unsure how to configure an MCP with your client, please refer to your MCP client's official documentation.

#### 🧩 Engines

<summary><strong>Option 1: Using NPX</strong></summary>

This option requires Node.js to be installed on your system.

1. Add the following to your MCP configuration file:
```json
{
  "mcpServers": {
    "substack-api": {
      "command": "npx",
      "args": ["-y", "substack-mcp@latest"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "<YOUR_PUBLICATION_URL>",
        "SUBSTACK_SESSION_TOKEN": "<YOUR_SESSION_TOKEN>",
        "SUBSTACK_USER_ID": "<YOUR_USER_ID>"
      }
    }
  }
}
```

2. Replace `<SUBSTACK_PUBLICATION_URL>`, `<YOUR_SESSION_TOKEN>` and `<YOUR_USER_ID>` with your credentials.

<summary><strong>Option 2: Using Docker</strong></summary>

This option requires Docker to be installed on your system.

1. Add the following to your MCP configuration file:
```json
{
  "mcpServers": {
    "substack-api": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "SUBSTACK_PUBLICATION_URL",
        "-e",
        "SUBSTACK_SESSION_TOKEN",
        "-e",
        "SUBSTACK_USER_ID",
        "marcomoauro/substack-mcp:latest"
      ],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "<YOUR_PUBLICATION_URL>",
        "SUBSTACK_SESSION_TOKEN": "<YOUR_SESSION_TOKEN>",
        "SUBSTACK_USER_ID": "<YOUR_USER_ID>"
      }
    }
  }
}
```

2. Replace `<SUBSTACK_PUBLICATION_URL>`, `<YOUR_SESSION_TOKEN>` and `<YOUR_USER_ID>` with your credentials.

### 🪵 Logs

The server logs what it does as one JSON object per line, on **stderr** — MCP clients collect it
into their own log file (on macOS, Claude Desktop writes it to
`~/Library/Logs/Claude/mcp-server-substack-api.log`). It is the fastest way to see what your LLM
actually sent when a call does not do what you expected:

```json
{"ts":"2026-08-07T10:12:03.114Z","level":"info","msg":"tool.call.start","tool":"create_draft_post","args":{"title":"My title","subtitle":"My subtitle","body":"…"}}
{"ts":"2026-08-07T10:12:03.402Z","level":"info","msg":"substack.response","status":200,"duration_ms":287}
{"ts":"2026-08-07T10:12:03.403Z","level":"info","msg":"create_draft_post.created","draft_id":167712345}
```

Set the optional `SUBSTACK_MCP_LOG_LEVEL` env var alongside your credentials to change how much
is written:

| Value | What you get |
|---|---|
| `silent` | nothing |
| `error` | failed calls only |
| `warn` | the above, plus every answer the client received as an error — including calls rejected for bad arguments before they ran |
| `info` *(default)* | the above, plus every tool call, request and response |
| `debug` | the above, plus full payloads and every JSON-RPC message |

Your session token is never written to the log, at any level.

## 💻 Popular Clients that supports MCPs

> For a complete list of MCP clients and their feature support, visit the [official MCP clients page](https://modelcontextprotocol.io/clients).

| Client                                                                                                         | Description |
|----------------------------------------------------------------------------------------------------------------|-------------|
| [Claude Desktop](https://claude.ai/download)                                                                   | Desktop application for Claude AI |
| [Cursor](https://www.cursor.com/)                                                                              | AI-first code editor |
| [Cline for VS Code](https://github.com/cline/cline)                                                            | VS Code extension for AI assistance |
| [GitHub Copilot MCP](https://github.com/VikashLoomba/copilot-mcp)                                              | VS Code extension for GitHub Copilot MCP integration |
| [Windsurf](https://windsurf.com/editor)                                                                        | AI-powered code editor and development environment |

## 🆘 Support

- For issues with this MCP Server: Open an issue on [GitHub](https://github.com/marcomoauro/substack-mcp/issues)
