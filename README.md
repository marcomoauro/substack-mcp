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

**Returns**: `{draft_id, is_published}`. Pass `draft_id` to `get_draft` to read the draft back.
</details>

<details>
<summary><strong>list_subscribers</strong> - List and filter your subscribers</summary>

Exposes the same filtering the Subscribers dashboard offers: 48 columns, 18 operators, free-text
search, sorting and pagination.

**Inputs**:
- `filters` (array, optional): conditions combined with **AND**, each `{column, operator, value}`
- `search` (string, optional): free text matched against subscriber name and email
- `sort_by` (string, optional): any filterable column
- `sort_direction` (`asc` | `desc`, optional): defaults to `desc`
- `limit` (number, optional): 1–100, defaults to 25
- `offset` (number, optional): for paging

Which operators a column accepts depends on its type:

| Type | Operators |
|---|---|
| `Int` | `is` `is_not` `gt` `gte` `lt` `lte` |
| `String` | `is` `is_not` `is_any_of` `contains` `starts_with` `ends_with` `includes_none` |
| `DateTime` | `is_on` `is_after` `is_on_or_after` `is_before` `is_on_or_before` |
| `Array` (`tag_ids`, `emails_enabled`) | `includes_any` `includes_all` `includes_none` |
| `subscription_type`, `group_membership` | `is` `is_not` `is_any_of` |

The columns cover subscriber identity (name, email, country, state, group membership),
subscription (type, start/expiry/cancel dates, revenue, Stripe plan, attribution), email
engagement (opens and unique opens over 7d/30d/6mo, links clicked, sections) and site engagement
(post views, unique posts seen, comments, shares, days active, activity rating). The full list
with types reaches the client in the tool's JSON Schema, so a model does not have to guess names.

**Returns**: `{count, returned, limit, offset, subscribers}`. `count` is the total matching the
filters regardless of `limit`, so a call with `limit: 1` is a cheap way to size a segment.

> **Note**: engagement columns can be *filtered* on but are not part of the returned records —
> Substack takes the fields it returns from the publication's saved Display settings and ignores a
> per-request column list. Use `count` with different thresholds to learn about them.

There is no OR and no nesting: anything needing OR has to be issued as separate calls.
</details>

<details>
<summary><strong>list_posts</strong> - List drafts, published or scheduled posts</summary>

**Inputs**:
- `status` (`drafts` | `published` | `scheduled`): which list to read
- `search` (string, optional): free text matched against title and content
- `limit` (number, optional): 1–100, defaults to 25
- `offset` (number, optional): for paging
- `sort_direction` (`asc` | `desc`, optional): drafts and published posts are newest-first,
  scheduled posts soonest-first

**Returns**: `{status, total, returned, limit, offset, posts}`, each post summarised — use
`get_draft` for the full content of an unpublished one.
</details>

<details>
<summary><strong>get_draft</strong> - Read one draft in full</summary>

**Inputs**:
- `draft_id` (number): the id returned by `list_posts` or `create_draft_post`

**Returns**: the draft as Substack stores it, body and audience/email settings included.
</details>

<details>
<summary><strong>get_publication_stats</strong> - Read the headline stats</summary>

**Inputs**: none.

**Returns**: total and recent subscribers, email and app subscribers, ARR, site views and the
30-day email open rate, each with its change where Substack reports one. If one of the underlying
endpoints fails the rest are still returned, and the failure is named under `errors`.
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

This option requires Node.js 22 or newer to be installed on your system.

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
        "run", "-i", "--rm",
        "-e", "SUBSTACK_PUBLICATION_URL",
        "-e", "SUBSTACK_SESSION_TOKEN",
        "-e", "SUBSTACK_USER_ID",
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

### 🏗 Running from Source

Use this if you want to hack on the server itself. There is no build step — the sources are plain
ESM and run as they are.

#### Node.js

```bash
git clone https://github.com/marcomoauro/substack-mcp.git
cd substack-mcp
npm install
```

Then add to your MCP config:

```json
{
  "mcpServers": {
    "substack-api": {
      "command": "node",
      "args": ["<FULL_PATH_TO_PROJECT>/src/index.js"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "<YOUR_PUBLICATION_URL>",
        "SUBSTACK_SESSION_TOKEN": "<YOUR_SESSION_TOKEN>",
        "SUBSTACK_USER_ID": "<YOUR_USER_ID>"
      }
    }
  }
}
```

#### Docker

```bash
git clone https://github.com/marcomoauro/substack-mcp.git
cd substack-mcp
docker build -t substack-mcp .
```

Then add to your MCP config:

```json
{
  "mcpServers": {
    "substack-api": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SUBSTACK_PUBLICATION_URL",
        "-e", "SUBSTACK_SESSION_TOKEN",
        "-e", "SUBSTACK_USER_ID",
        "substack-mcp"
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
