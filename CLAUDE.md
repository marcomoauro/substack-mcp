# CLAUDE.md

MCP server exposing Substack automation to LLM clients. ESM, npm. Development, CI and the image
run **Node 24** — `.nvmrc` and `Dockerfile` pin `24.19.0` exactly — while `engines` declares
`>=22`, so `src/` may use nothing newer than Node 22 offers.

That floor is deliberate, not inherited: 22 is the oldest Node line still receiving security
patches (18 went EOL 2025-04-30, 20 on 2026-04-30), and it is the lowest version every
production dependency accepts — `@hono/node-server` asks for `>=20`, everything else `>=18`.
Raising it breaks anyone running `npx substack-mcp@latest` on an older runtime, so it is a major
bump; the honest ceiling is the oldest supported LTS, not the version that happens to be
installed locally.

**Two CI jobs run the suite: one on `.nvmrc`, one on the floor.** The floor job derives its
version from `engines` (`node -p "require('./package.json').engines.node.match(/\d+/)[0]"`)
rather than repeating it, so the promise and the test cannot drift. Developing two majors above
the floor is precisely how an unexercised `engines` rots into a lie — the runtime differences
are real and silent, as the `fetch` stack below shows.

## Language

**Everything in the repository is written in English** — source, comments, test names,
commit messages, PR titles and descriptions, docs. This holds regardless of the language
used in the chat: do not mirror the conversation language into the codebase.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Install from `package-lock.json` (never `npm install` in CI or Docker) |
| `npm test` | Run the suite (`node --test 'src/**/*.spec.js'`) |
| `npm run test:watch` | Same, in watch mode |
| `npm run test:coverage` | Coverage report, spec files excluded |
| `npm pack --dry-run` | Verify what ships to npm |

`npm test` runs in under a second, but **its output shape depends on the Node version**: on 24 it
is the spec reporter (tally `ℹ pass`, failures marked `✖`), on the 22 floor it is TAP — five times
noisier, tally `# pass`, failures `not ok`. Grep for both, or a perfectly green run on the wrong
version comes back empty and reads as a broken command: `grep -E '^(#|ℹ) (tests|pass|fail)'` for
the tally, `grep -E '^(not ok|✖)'` for what broke.

## Layout

- `src/index.js` — entrypoint only: env check, `createServer()`, stdio transport. Keep it thin.
- `src/server.js` — `createServer()` factory plus the `tools` registry. **No side effects at
  import time**: no env reads, no transport connection. Tests depend on this.
- `src/tools/<name>.js` — one file per MCP tool, exporting a zod schema and a handler.
- `src/api/substack/` — `SubstackApi` (HTTP), `SubstackPost` (ProseMirror document builder) and
  `SubscriberQuery` (the subscriber filter DSL).
- `src/logger.js` — the only place that writes a log line. No dependencies, no state.
- `test/helpers/` — shared test helpers only; no tests live here.

Adding a tool means adding a file under `src/tools/` and one entry to the `tools` registry in
`src/server.js` — nothing else. `createServer()` loops over the registry calling
`McpServer.registerTool`, and the SDK derives `tools/list`, argument validation and dispatch
from what was registered, so there is no second place to update and nothing that can drift.
Do not add `setRequestHandler` calls for `tools/list` or `tools/call`: registering a tool
already covers both, and the SDK guards the clash rather than letting it slide — it throws
`A request handler for tools/call already exists, which would be overridden`.

## Substack's private API

There is no public documentation for any of this. Every endpoint below was read off the publisher
dashboard's own traffic and its `reactPublish.*.js` bundle, then confirmed against the live API —
so **check behaviour against a real request before trusting a claim about it**, including the
claims here. An official, key-authenticated Publisher API exists (`publisher_api_enabled`,
`/api/v1/publisher_api/api_key`) but is gated: the key endpoint answers **403** on a publication
that does not have it. If it ever opens up it is a better foundation than a session cookie.

**`POST /api/v1/subscriber-stats` is the whole subscriber surface** — list, filter, sort and search
in one call. `src/api/substack/SubscriberQuery.js` owns the translation, and the reasons it exists
rather than passing arguments straight through:

- A filter is a **flat key** inside `filters`: column name with an operator suffix glued on
  (`num_comments_gt`). Multiple keys are ANDed. **No OR, no nesting** — an OR needs separate calls.
- **The suffix depends on the column's type**, and the API answers every mismatch with a bare 400
  that names neither the column nor the alternatives. `is not` is `_not` on `subscription_type`,
  `_distinct_from` on an Int or `group_membership`, and `_string_not` on a String. `_lte` is
  Int-only; the DateTime equivalent is `_is_on_or_before`, not `_lte`. So the tool exposes operators
  named by intent and derives the suffix, which makes an illegal pair unrepresentable rather than a
  round trip away.
- **`search` goes inside `filters`.** At the top level it is ignored *silently* and the response
  comes back unfiltered — which reads as "search matched everything", not as an error.
- **Sorting is two different keys**: `order_by` ascending, `order_by_desc_nulls_last` descending.
- **The API validates enum values too**, so `subscription_type: 'premium'` is a 400. The valid sets
  are `paid|free|founding|comp|gift|free_trial|iap` and `none|member|admin`.
- `count` is the total matching the filters regardless of `limit`, which makes `limit: 1` a cheap
  way to size a segment.
- **A request-level `columnView` is ignored.** The returned fields come from the publication's saved
  Display settings, so this endpoint cannot be made to return the engagement columns. That does not
  make them unreadable — the export below does read them — so `list_subscribers` points at
  `export_subscribers` rather than telling the caller the data does not exist.

**The subscriber export is a four-step flow, and it is what makes every column readable.**
`src/tools/export_subscribers.js` owns it:

```
POST /api/v1/subscriber_set                    {query: <the same filters>}  → {id}
POST /api/v1/subscriber_set/export             {subscriberSetId, columns}   → {export_id}
GET  /api/v1/subscriber_set/export/<id>                                     → {url}   (poll)
GET  <url>                                                                  → CSV
```

Verified end to end. The dashboard's polling backoff is `1, 5, 10, 30`, then `60` repeated;
`EXPORT_POLL_BACKOFF_SECONDS` mirrors it, except the first poll happens immediately because a small
export is usually already done. Four things this flow gets wrong if taken at face value:

- **The CSV header carries human LABELS, not column keys** — `Emails opened (6mo)`, not
  `num_email_opens`. `COLUMN_KEY_BY_LABEL` is the reverse map; it works because the labels are
  unique, which `SubscriberQuery.spec.js` asserts by entry count so a future collision fails loudly
  instead of dropping a column.
- **The server chooses the column order**, not the caller. Parse by header name, never by position.
- **Two columns cannot be exported and are dropped in silence:** `tag_ids` and `group_membership`.
  Asking for all 48 returns 46 with no error, so the tool diffs what it asked for against the header
  and reports `missing_columns`. This is the same silent-drop hazard as `columnView`.
- **The download url is relative to the publication host and cookie-authenticated** (403 without it,
  not pre-signed) and answers **CSV, not JSON**. `handleResponse` unconditionally `JSON.parse`s, so
  `readBody` was split out of it and `requestUrl({parse: 'text'})` is the raw path. `requestUrl` also
  exists because that url cannot be appended to `publication_url`, which already ends in `/api/v1`.

`src/api/substack/csv.js` is a ~40-line parser rather than a dependency. `split(',')` is not enough
and fails *silently*: a subscriber named `Smith, John` shifts every later column of that one row.

**The analytics reports live in one registry**, `ANALYTICS_REPORTS` in `src/tools/get_analytics.js`:
16 verified endpoints under `/publication/stats/`, exposed as one tool with a `report` enum rather
than 16 near-identical tools, which would make a model's choice harder rather than easier. Each entry
carries its path, whether it takes a date window (`from_date`/`to_date`, or full ISO `start`/`end`
for retention), a default `limit` for the two that answer 400 without one, and the fixed extras the
dashboard always sends. **An unexpected parameter is a 400 on several of these**, so a parameter that
does not apply to the chosen report is dropped *and named* in `ignored_params` — the same
silent-drop hazard as `columnView` and the export's columns, which is now three for three.

**`email_stats` is misnamed and is not one of those reports.** Despite living under
`/publication/stats/` it is the **per-post table** behind the dashboard's "Posts" tab — which itself
lives at `/publish/stats/emails`, not `/publish/stats/posts` — with one row per post across the whole
archive: 43 fields covering delivery, opens, clicks, conversion (`signups`, `subscribes`,
`free_to_paid_upgrades`, `estimated_value`), churn (`unsubscribes`) and completion
(`subscribers_finished_post`). It takes `offset`/`limit`/`order_by`/`order_direction`, so it belongs
to `src/tools/get_post_stats.js` and is deliberately absent from `ANALYTICS_REPORTS`; both specs
assert the split, because two doors to the same data would mean choosing between a full report and a
crippled one. Two measured facts shape that tool:

- **`order_by` must be validated against the field list.** An unrecognised value answers **200** with
  an arbitrary order, so a typo yields a ranking that looks authoritative. The enum is the only
  guard — this is the *fourth* silent-ignore in this API.
- **There is no date filter.** `from_date`/`to_date` leave `total` unchanged at 863, so the schema
  does not offer them; `strictObject` then tells a caller that guesses `from_date` that it is
  unrecognised, which is the difference between knowing there is no window and believing there is.
  Sorting works for real, though: `signups` descending returns 42, 41, 41, 27, 23… Ranking by a
  *rate* puts `null` first, and the tool does not filter those out — that would answer a different
  question than the one asked.

**Two endpoints next to them are broken upstream, not mis-called:**
`/publication/stats/audience_insights/location` (the subscriber map) and
`/publication/stats/visitor_sources` answer **400 even for Substack's own dashboard** — observed in
the page's own network log, with and without parameters. They are deliberately absent from the
registry, and `get_analytics.spec.js` asserts they stay absent. Do not "fix" them by guessing params.

**`GET /api/v1/post_management/{drafts,published,scheduled}`** lists posts. `order_by` is **not
optional**: `scheduled` answers 400 without it, which is why `src/tools/list_posts.js` keeps a
default per status rather than letting the server choose. Free-text search is `query`, and a null
one must never be serialized — `query=null` searches for the literal string. `GET /api/v1/drafts/:id`
returns a single draft whole.

## Logging

**Everything must be logged well enough to debug a session from the log alone**, because the
caller is an LLM and the failure is usually in what it sent, not in this code. Every new tool,
method or branch that a call can take gets a line: the arguments it received, the decision it
made, the outcome. `src/logger.js` is the only writer — never `console.log`.

- **stdout belongs to the JSON-RPC transport.** One byte written there corrupts the protocol
  and the client disconnects, which is why the logger writes to stderr and why
  `src/index.spec.js` asserts that stdout parses as JSON-RPC and stderr as log lines. MCP hosts
  collect the server's stderr into their own log files; that is where these lines get read.
- One JSON object per line: `{"ts","level","msg",…fields}`. `msg` is a dotted event name
  (`tool.call.start`, `substack.response`), not a sentence — it is what you grep for.
- Levels are `silent < error < warn < info < debug`, from `SUBSTACK_MCP_LOG_LEVEL`, default
  `info`, read **at call time** (nothing in `src/` may read the environment at import time).
  `info` is the story of a call — tool in, request out, response, result. `debug` adds the
  payloads and the document-building steps. An unknown value falls back to `info` rather than
  muting the server.
- **Secrets are redacted by key name**, recursively: `/token|cookie|password|secret|auth|session|^sid$/i`
  becomes `***`. So pass whole objects (`{headers}`, `{args}`, `{draft}`) and let the logger
  handle it, rather than picking fields by hand at each call site. Post content is *not*
  truncated — it is usually the thing being debugged.
- **Two carve-outs keep the pattern from eating the diagnosis.** `sid` is anchored (`^sid$`)
  because as a substring it also matches `considerations`. And a **boolean** under a secret key
  survives: one bit cannot leak a credential, while redacting it turns the useful part of the
  line into `***` — `has_auth_token: Boolean(auth_token)` logged as `"***"`, stating only that
  the field exists, is a bug this repo has already shipped once.
- The logger never throws: `Error` values are expanded to `{name, message, stack, cause?}` (raw,
  they serialize to `{}`), cycles become `[Circular]`, and an unserializable payload degrades to
  a `log_error` note.
- **`cause` is expanded recursively, and on Node 24 it is the whole diagnosis.** Native `fetch`
  rejects with `TypeError: fetch failed` whose stack has **no frames at all** — Node 22 still
  attached the caller's async frames, which is why the Node 24 bump turned one entrypoint test
  red. Everything actionable hangs off `.cause`, so `redact` follows the chain (through the same
  redaction as any payload, since a cause is not a trusted container). Logging only
  `{name, message, stack}` there yields a line stating that something failed and nothing about
  what.
- **A rejected tool call cannot be logged from inside the handler.** `McpServer` validates
  arguments itself and answers `Input validation error` before the handler runs, so
  `logOutgoingMessages(transport)` wraps `transport.send` to catch it — `warn` for anything
  carrying `error` or `isError`, `debug` for the rest of the traffic. That line is the most
  useful one in the file when a model cannot get a call right.
- Tool failures are logged **and rethrown**: `McpServer` still converts them into an `isError`
  result. Swallowing one would change the protocol behaviour.
- `setTestEnv()` forces `SUBSTACK_MCP_LOG_LEVEL=silent`. **Call it from every spec whose subject
  logs**, including one that reads no env var of its own — `SubstackPost.spec.js` needs it purely
  for this, and the two `src/api/substack` suites once printed 14 log lines over the reporter for
  want of it. Assert on logs with `test/helpers/capture-logs.js`, which sets the level and
  captures stderr for the duration of a call.

## Testing

Tests are colocated with their subject as `<name>.spec.js` (e.g. `SubstackApi.spec.js` sits
next to `SubstackApi.js`). They are excluded from the npm tarball via the `files` negation
pattern and from the Docker image via `.dockerignore` — update both if the naming changes.

**All outbound HTTP is mocked with MSW**, configured with `onUnhandledRequest: 'error'` so an
unmocked request fails the test instead of reaching the network. Never disable that. Build
overrides with `msw.draftsHandler(...)` rather than a bare `http.post`, otherwise the request
is not recorded in `msw.requests`.

The exception is `src/index.spec.js`, which spawns the entrypoint as a child process: MSW runs
in the test process and cannot intercept anything there. To exercise a failing request, point
`SUBSTACK_PUBLICATION_URL` at `http://127.0.0.1:1` — the request gets logged, then fails without
a packet leaving the machine. Port 1 is on the fetch spec's blocked-port list, so it never even
reaches a connect: the rejection is `TypeError: fetch failed` with `cause.message` of
`bad port`, not the ECONNREFUSED this file used to claim. Assert on the *shape* of that failure
(a cause with frames), not on either message — both are runtime detail.

Tests that pin *current* behaviour rather than desired behaviour carry a `CHARACTERIZATION`
comment explaining why. If one fails, suspect the test before the source — that is the point
of it. Update the comment in the same commit that changes the behaviour.

**A new test that passes on the first run has proven nothing.** Break the source on purpose —
revert the fix, strip the field, loosen the schema — confirm it fails, restore. This caught
three tests that were passing vacuously: `additionalProperties` was dropped from the published
schema with nobody noticing, the schema test survived having every `description` stripped, and
"never writes the session token to the log" passed with redaction disabled, because the
handshake it drove never logs a request header in the first place — it now drives a real tool
call against a closed local port. Renaming the log line under test is the cheapest mutation for
a logging assertion. **Check the mutation actually landed** before trusting a green run: a
`sed`/`perl` regex that fails to match leaves the file untouched and reads exactly like a test
that asserts nothing. Grep the file for a marker first. The whole suite runs in well under a
second, so a mutation costs nothing.

## Style

Two-space indent, semicolons, single quotes in code (imports use double), compact object
literals (`{a: 1}`, not `{ a: 1 }`).

## Gotchas

- **Dependencies are pinned exactly** — no `^` or `~` ranges anywhere. The project `.npmrc`
  sets `save-exact=true` so `npm install <pkg>` keeps it that way; do not add ranges by hand.
- **npm 11 (bundled with Node 24) does not run dependency lifecycle scripts by default.** `npm ci`
  prints an `allow-scripts` warning and skips msw's `postinstall`; the suite passes anyway,
  because that script already swallows its own errors. Noise, not a failure — do not "fix" it by
  approving scripts.
- **`node --test` does not discover `*.spec.js`** with its default patterns. The npm scripts
  pass the glob `'src/**/*.spec.js'` explicitly; single quotes matter so Node expands it, not
  the shell.
- **Check the SDK's own source before asserting how it behaves.** Nearly every gotcha below
  depends on SDK internals, and it ships readable ESM in
  `node_modules/@modelcontextprotocol/sdk/dist/esm/`: `server/mcp.js` (registration,
  validation, published tool definition), `server/zod-json-schema-compat.js` (schema
  generation), `shared/protocol.js` (handler registration). Reading it is how the
  `{target: 'draft-7', io: 'input'}` options and the silent `zod-to-json-schema` failure were
  found; assuming instead once put a false claim in this very file.
- **Tool failures are results, not rejections.** `McpServer` turns anything a tool throws —
  a validation error, an unknown tool name, a `SubstackAPIException` — into a *successful*
  `CallToolResult` with `isError: true` and the message in `content[0].text`. `client.callTool()`
  does **not** reject, so `await client.callTool(...).catch(e => e)` hands you the *result*, not
  an error: `assert.match(error.message, ...)` then dies with `The "string" argument must be of
  type string` instead of a useful diff, while anything looser (`assert.ok(error)`) passes while
  checking nothing. Assert `result.isError` and `result.content[0].text` instead.
  (Protocol-level failures — an unknown *method*, a malformed request — are still `McpError`,
  prefixed `MCP error -32601: ` and friends.)
- **`callTool` results are `JSON.stringify`-ed by the server**, so a handler returning `'OK'`
  arrives as `text: '"OK"'` — quotes included.
- **`SubstackPost.getDraft()` calls `JSON.stringify` on `draft_body`**, so it must be handed an
  object. Passing a string double-encodes it; this was a real bug (#4).
- **HTTP goes through native `fetch`** — no HTTP client dependency. `fetch` does not reject on
  non-2xx, so `SubstackApi.handleResponse` is what turns a failing status into an error
  (`SubstackAPIException: <status> <statusText>`); it also serializes the body and sets
  `Content-Type` by hand, which axios used to do implicitly.
- **The SDK owns JSON Schema generation** — never convert a schema by hand. `registerTool`
  publishes `inputSchema` itself, via `z.toJSONSchema(schema, {target: 'draft-7', io: 'input'})`
  under the hood (`server/zod-json-schema-compat.js`). If you are ever tempted back to the
  low-level `Server`, know that `zod-to-json-schema` returns a bare `{$schema}` for a zod 4
  schema **without throwing**, publishing a parameterless tool to every client.
- **Tool schemas are `z.strictObject`, never `z.object`.** The validation message is the only
  feedback an LLM gets to repair a malformed call, and a plain `z.object` *strips* unknown keys
  silently: a model sending `content` instead of `body` is told only that `body` is missing,
  never that its own key was ignored. `strictObject` adds `Unrecognized key: "content"`, and
  makes the published `additionalProperties: false` truthful instead of an empty promise.
  Prefer `z.strictObject({...})` over `.strict()` — zod 4 points at the former.
  `src/server.spec.js` pins the wording of these messages on purpose: a degraded message
  breaks nothing by itself, the call still returns, so only an explicit assertion catches it.
- **zod is not optional and not ours to drop.** It is a non-optional `peerDependency` of the
  SDK, and `registerTool` throws `inputSchema must be a Zod schema or raw shape` for anything
  else — the SDK's validation *is* zod. npm auto-installs it even if it leaves `package.json`,
  so removing the direct dependency buys nothing and unpins the version.
- **`ZodError` details live on `.issues`, not `.errors`** (zod 4 renamed it). The only reader in
  `src/` is the `create_draft_post.args.invalid` log — the SDK formats the message it sends to
  the client — and `.errors` silently yields `undefined` rather than failing, so a handler that
  inspects them logs nothing and reports no error.

## Verifying the server actually works

`src/index.spec.js` now automates this: it spawns the real entrypoint as a child process,
completes the handshake over stdio and asserts the env-var guard. It is the only coverage
`src/index.js` has, since the file does its work at import time.

Still drive it by hand when changing the transport or the protocol surface — the assertions
only check what they were told to check:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SUBSTACK_PUBLICATION_URL=https://test.substack.com SUBSTACK_SESSION_TOKEN=tok SUBSTACK_USER_ID=1 \
    timeout 5 node src/index.js
```

Note the process exits 0 immediately when stdin is at EOF — that is normal, not a crash, so
exit status alone tells you nothing.

Diff this output before and after a refactor to prove the protocol is unchanged, but normalise
each line first or key-order churn swamps the real change — `$schema` merely moving position
reads as a diff:

```bash
diff <(python3 -m json.tool --sort-keys <<< "$(sed -n '2p' before.txt)") \
     <(python3 -m json.tool --sort-keys <<< "$(sed -n '2p' after.txt)")
```

**Two runtimes, so verify at both ends of the range** when touching anything runtime-sensitive
(`fetch`, errors, streams). CI does this on every push; locally nvm is a shell function, so a
non-interactive shell has to source it first:

```bash
source ~/.nvm/nvm.sh && nvm exec --silent 22 npm test && nvm use && npm test
```

**The image is a shipped artifact the suite never touches.** After a base-image bump, confirm the
runtime is what you think and that the server still answers — the probe above works unchanged
with `docker run -i --rm -e … substack-mcp:check` in place of `node src/index.js`:

```bash
docker build -t substack-mcp:check . && docker run --rm --entrypoint node substack-mcp:check --version
```
