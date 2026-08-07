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

> **Note**: engagement columns can be *filtered* on here but are not part of the records this tool
> returns — Substack takes the fields it returns from the publication's saved Display settings and
> ignores a per-request column list. Use **`export_subscribers`** to read their values.

There is no OR and no nesting: anything needing OR has to be issued as separate calls.
</details>

<details>
<summary><strong>export_subscribers</strong> - Export subscribers with every column value</summary>

The way to actually *read* the engagement metrics `list_subscribers` can only filter on: email opens
over 7d/30d/6mo, unique emails seen, post views, unique posts seen, comments, shares, links clicked,
days active and activity rating.

**Inputs**:
- `filters` (array, optional): the same conditions as `list_subscribers`, combined with AND
- `search` (string, optional): free text matched against subscriber name and email
- `columns` (array, optional): which columns to include, defaulting to **all** of them
- `max_wait_seconds` (number, optional): 1–600, defaulting to 120

**Returns**: `{count, columns, missing_columns, unmapped_columns, export_id, subscribers}`, where
each subscriber is keyed by column name.

Substack generates the file asynchronously, so the tool creates a subscriber set, requests the
export, polls until it is ready and downloads it. A small export lands in a few seconds. If the wait
budget runs out the tool says so and names the `export_id` rather than blocking.

> **Two caveats**, both verified against the live API:
> - `tag_ids` and `group_membership` **cannot** be exported. Substack drops them silently rather
>   than failing, so they are reported in `missing_columns` — asking for all 48 columns returns 46.
> - Values arrive **display-formatted**, not raw: revenue is `"€50.00"` here and the number `50`
>   through `list_subscribers`. Dates are ISO strings.

There is no paging: an export covers the whole matching set.
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
<summary><strong>update_draft</strong> - Change a draft's title, subtitle or audience</summary>

The update is **partial**: only the fields you pass change, and the body is left alone.

**Inputs**:
- `draft_id` (number): the id returned by `list_posts` or `create_draft_post`
- `draft_title` (string, optional)
- `draft_subtitle` (string, optional)
- `audience` (`everyone` | `only_paid` | `founding`, optional)

**Returns**: `{draft_id, updated_fields, draft_title, draft_subtitle, audience, is_published}`.
A call with no field to change is refused rather than sent as a no-op.
</details>

<details>
<summary><strong>publish_draft</strong> - Publish a draft</summary>

**Inputs**:
- `draft_id` (number): the id returned by `list_posts` or `create_draft_post`
- `send` (boolean, optional): email the post to subscribers. **Defaults to `false`**, unlike the
  Substack API's own default — the post goes live on the web either way, but an email cannot be
  recalled, so it has to be asked for explicitly.
- `share_automatically` (boolean, optional): let Substack auto-share to Notes. Defaults to `false`.

**Returns**: `{status, draft_id, post_id, title, slug, canonical_url, emailed, shared_automatically}`.

There is no unpublish tool: publishing cannot be undone from this server.
</details>

<details>
<summary><strong>delete_draft</strong> - Delete an unpublished draft</summary>

**Inputs**:
- `draft_id` (number): the id returned by `list_posts` or `create_draft_post`

**Returns**: `{status, draft_id, draft_title}`.

Substack deletes drafts and published posts through the *same* endpoint, so this tool reads the
target first and **refuses if it is published** — removing a live post is irreversible and is left
to the dashboard.
</details>

<details>
<summary><strong>get_publication</strong> - Read your publication's settings</summary>

**Inputs**:
- `full` (boolean, optional): return all 111 fields (~24 KB) instead of the projection.
  Defaults to `false`.

**Returns**: by default a projection — name, subdomain, custom domain, hero text, copyright, sender
name, logo, plans, payment state and the community/podcast flags — plus `_meta` naming how many
fields were dropped. The full payload is mostly notification toggles and the raw HTML of the welcome
email, terms and privacy pages.
</details>

<details>
<summary><strong>get_user_profile</strong> - Read the account behind the session</summary>

**Inputs**:
- `full` (boolean, optional): include the complete `subscriptions` array. Defaults to `false`.

**Returns**: `{id, name, handle, bio, photo_url, publications, primary_publication_id,
subscription_count}`. `publications` lists every publication the session has a role on, which is how
to discover that `SUBSTACK_PUBLICATION_URL` is not the only one it could be pointed at.
</details>

<details>
<summary><strong>get_publication_stats</strong> - Read the headline stats</summary>

**Inputs**: none.

**Returns**: total and recent subscribers, email and app subscribers, ARR, site views and the
30-day email open rate, each with its change where Substack reports one. If one of the underlying
endpoints fails the rest are still returned, and the failure is named under `errors`.

For anything deeper, use `get_analytics`.
</details>

<details>
<summary><strong>get_post_stats</strong> - Rank your posts by any of 43 metrics</summary>

Which post actually grew the list, which was worth most, which cost you subscribers. The dashboard's
"Posts" tab, sortable and paged.

**Inputs**:
- `order_by` (string, optional): any of the 43 metrics, defaulting to `post_date`
- `order_direction` (`asc` | `desc`, optional): defaults to `desc`
- `limit` (number, optional): 1–100, defaults to 25
- `offset` (number, optional): for paging the archive

The metrics worth reaching for:

| group | fields |
|---|---|
| conversion | `signups` `subscribes` `founding_subscribes` `annual_subscribes` `monthly_subscribes` `free_trials` `free_to_paid_upgrades` `signups_within_1_day` `estimated_value` |
| churn | `unsubscribes` |
| reading | `opens` `open_rate` `clicks` `click_through_rate` `views` `subscribers_finished_post` |
| social | `likes` `shares` `restacks` `engagement_rate` `unique_engagements` |
| delivery | `queued` `sent` `delivered` `dropped` |
| video / podcast | `video_views` `video_minutes_watched` `downloads` `downloads_day30` … |

**Returns**: `{total, returned, limit, offset, order_by, order_direction, posts}`. `total` is the
whole archive, not the page; `order_by` and `order_direction` are echoed so a ranking is never read
without knowing what produced it.

> **Two caveats**, both verified:
> - **There is no date filter.** `from_date`/`to_date` are ignored by this endpoint — `total` does not
>   change — so the schema does not offer them. Narrow by sorting and paging instead.
> - Ranking by a **rate** (`open_rate`, `engagement_rate`, `click_through_rate`) descending puts posts
>   with no data first, because `null` sorts before numbers. The tool does not filter them out, since
>   that would silently answer a different question.
>
> `order_by` is an enum on purpose: the API answers `200` for a field it does not recognise and
> returns an arbitrary order, so a typo would produce a ranking that looks authoritative.
</details>

<details>
<summary><strong>get_analytics</strong> - Read one of 16 publication-level reports</summary>

Everything behind the dashboard's Stats tabs, as one tool with a `report` enum rather than
seventeen near-identical tools.

**Inputs**:
- `report` (string): which report to read — see the table below
- `from_date`, `to_date` (string, optional): `YYYY-MM-DD`. Used only by the reports covering a
  period, which default to the last 30 days
- `limit` (number, optional): 1–100, used only by `audience_overlap` and `subscriber_notes`

| report | what it tells you |
|---|---|
| `retention` | cohort retention — how much of each signup cohort is still subscribed months later |
| `retention_summary` | headline retention at 1, 6 and 12 months |
| `unsubscribes` / `unsubscribes_timeseries` | churn, with the reasons given |
| `growth_sources` | where new subscribers came from, ranked |
| `growth_events` | the individual growth events in a window |
| `referrals_leaderboard` / `referrals_summary` | who refers most; gifts sent, accepted, converted |
| `audience_overlap` | other Substacks whose audience overlaps yours — the collaboration shortlist |
| `audience_locations` | how many countries and US states your subscribers span |
| `subscriber_notes` | recent Notes written by your subscribers |
| `paid_subscriber_growth` | paid growth rate, new subscriptions, expirations |
| `subscribers_timeseries`, `followers_timeseries`, `arr_timeseries` | counts and revenue over time |
| `network_attribution` | what share of subscribers arrived via the Substack network |

**Returns**: `{report, params, ignored_params, data}`. `params` is what was actually sent, defaults
included — the same report answers very differently over a different window, so the numbers mean
little without it. `ignored_params` names anything you passed that the chosen report does not
accept, rather than dropping it silently.

> Two neighbouring endpoints are deliberately **not** exposed: `audience_insights/location` (the
> subscriber map) and `visitor_sources` answer `400` even for Substack's own dashboard, so they are
> broken upstream rather than mis-called.
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
