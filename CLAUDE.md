# CLAUDE.md

MCP server exposing Substack automation to LLM clients. ESM, npm. Development and CI run on
Node 22 (`.nvmrc`, `Dockerfile`); `engines` declares `>=18`, the floor imposed by native
`fetch` — do not use APIs newer than that in `src/`.

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

## Layout

- `src/index.js` — entrypoint only: env check, `createServer()`, stdio transport. Keep it thin.
- `src/server.js` — `createServer()` factory plus the `tools` registry. **No side effects at
  import time**: no env reads, no transport connection. Tests depend on this.
- `src/tools/<name>.js` — one file per MCP tool, exporting a zod schema and a handler.
- `src/api/substack/` — `SubstackApi` (HTTP) and `SubstackPost` (ProseMirror document builder).
- `test/helpers/` — shared test helpers only; no tests live here.

Adding a tool means adding a file under `src/tools/` and one entry to the `tools` registry in
`src/server.js` — nothing else. `createServer()` loops over the registry calling
`McpServer.registerTool`, and the SDK derives `tools/list`, argument validation and dispatch
from what was registered, so there is no second place to update and nothing that can drift.
Do not add `setRequestHandler` calls for `tools/list` or `tools/call`: registering a tool
already covers both, and the SDK guards the clash rather than letting it slide — it throws
`A request handler for tools/call already exists, which would be overridden`.

## Testing

Tests are colocated with their subject as `<name>.spec.js` (e.g. `SubstackApi.spec.js` sits
next to `SubstackApi.js`). They are excluded from the npm tarball via the `files` negation
pattern and from the Docker image via `.dockerignore` — update both if the naming changes.

**All outbound HTTP is mocked with MSW**, configured with `onUnhandledRequest: 'error'` so an
unmocked request fails the test instead of reaching the network. Never disable that. Build
overrides with `msw.draftsHandler(...)` rather than a bare `http.post`, otherwise the request
is not recorded in `msw.requests`.

Tests that pin *current* behaviour rather than desired behaviour carry a `CHARACTERIZATION`
comment explaining why. If one fails, suspect the test before the source — that is the point
of it. Update the comment in the same commit that changes the behaviour.

**A new test that passes on the first run has proven nothing.** Break the source on purpose —
revert the fix, strip the field, loosen the schema — confirm it fails, restore. This caught
two tests that were passing vacuously: `additionalProperties` was dropped from the published
schema with nobody noticing, and the schema test survived having every `description` stripped.
The whole suite runs in well under a second, so a mutation costs nothing.

## Style

Two-space indent, semicolons, single quotes in code (imports use double), compact object
literals (`{a: 1}`, not `{ a: 1 }`).

## Gotchas

- **Dependencies are pinned exactly** — no `^` or `~` ranges anywhere. The project `.npmrc`
  sets `save-exact=true` so `npm install <pkg>` keeps it that way; do not add ranges by hand.
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
- **`ZodError` details live on `.issues`, not `.errors`** (zod 4 renamed it). Nothing in `src/`
  reads them today — the SDK formats the message — but `.errors` silently yields `undefined`
  rather than failing, so it is worth knowing before writing a handler that inspects them.

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
