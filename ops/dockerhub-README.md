# substack-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Substack](https://substack.com):
27 tools that let an LLM client draft, publish, tag and measure posts, read and export your
subscribers, and work the reader side — Inbox, Notes, comments and restacks.

Multi-arch image (`linux/amd64`, `linux/arm64`), Node 24, no build step, stdio transport.

**Full documentation:** [github.com/marcomoauro/substack-mcp](https://github.com/marcomoauro/substack-mcp)

## Quick start

Add this to your MCP client's configuration file (Claude Desktop, Cursor, Cline, Copilot,
Windsurf — the shape is the same everywhere):

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

`-i` is required: the server speaks JSON-RPC over stdin/stdout.

## Environment

| Variable | Required | What it is |
|---|---|---|
| `SUBSTACK_PUBLICATION_URL` | yes | e.g. `https://yourname.substack.com` |
| `SUBSTACK_SESSION_TOKEN` | yes | your `substack.sid` session cookie |
| `SUBSTACK_USER_ID` | yes | your numeric Substack user id |
| `SUBSTACK_MCP_LOG_LEVEL` | no | `silent` \| `error` \| `warn` \| `info` (default) \| `debug` |

How to obtain the three credentials:
[implementing.substack.com/p/mcp-server-for-substack](https://implementing.substack.com/p/mcp-server-for-substack).

## Tools

**Drafts and publishing**

| Tool | What it does |
|---|---|
| `create_draft_post` | Create a draft from a title, subtitle and plain-text body |
| `set_post_body` | Replace a draft's body with a structured document — headings, lists, links, code, images, buttons, paywall |
| `update_draft` | Change the title, subtitle and the nine writable Post settings, cover image included |
| `get_draft` | Read one draft in full |
| `list_posts` | List drafts, published or scheduled posts |
| `publish_draft` | Publish a draft, with an explicit email-the-list decision |
| `delete_draft` | Delete an unpublished draft (refuses published posts) |
| `upload_image` | Re-host an external image on Substack's own bucket |

**Subscribers**

| Tool | What it does |
|---|---|
| `list_subscribers` | List and filter subscribers — 48 columns, 18 operators, search, sorting, paging |
| `export_subscribers` | Export the matching set with every column value, engagement metrics included |

**Stats**

| Tool | What it does |
|---|---|
| `get_publication_stats` | The headline numbers |
| `get_post_stats` | Rank the whole archive by any of 43 per-post metrics |
| `get_analytics` | 16 publication-level reports — growth, revenue, traffic, retention |

**Tags and comments**

| Tool | What it does |
|---|---|
| `list_publication_tags` / `get_post_tags` / `add_tag_to_post` | Read the tag list, read a post's tags, tag a post |
| `get_post_comments` / `comment_on_post` | Read the comments on your posts, reply to them |

**Reader side** (your account, not your publication)

| Tool | What it does |
|---|---|
| `list_subscriptions` | What this account subscribes to |
| `list_reader_posts` / `get_reader_post` | The Inbox, and any post read in full |
| `get_reader_feed` / `get_profile_feed` | The Notes feed, and what one account has published |
| `get_comment_thread` | A Note and its replies |
| `restack_item` | Restack a Note |
| `get_publication` / `get_user_profile` | Your publication's settings, and the account behind the session |

## Logs

One JSON object per line on **stderr** — MCP clients collect it into their own log file. It is the
fastest way to see what your LLM actually sent when a call did not do what you expected:

```json
{"ts":"2026-08-08T10:12:03.114Z","level":"info","msg":"tool.call.start","tool":"create_draft_post","args":{"title":"My title"}}
{"ts":"2026-08-08T10:12:03.402Z","level":"info","msg":"substack.response","status":200,"duration_ms":287}
```

Your session token is never written to the log, at any level.

## Tags

`latest` tracks the newest release. Every release is also published as `vX.Y.Z`, and every build as
its short commit SHA.

## Alternatives

Prefer no container? `npx -y substack-mcp@latest` runs the same server on Node 22 or newer —
see the [npm package](https://www.npmjs.com/package/substack-mcp).

## Support

Issues and feature requests: [github.com/marcomoauro/substack-mcp/issues](https://github.com/marcomoauro/substack-mcp/issues) · MIT licensed
