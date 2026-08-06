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
`src/server.js`. `list_tools` derives from that registry, so the two cannot drift apart.

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

## Style

Two-space indent, semicolons, single quotes in code (imports use double), compact object
literals (`{a: 1}`, not `{ a: 1 }`).

## Gotchas

- **Dependencies are pinned exactly** — no `^` or `~` ranges anywhere. The project `.npmrc`
  sets `save-exact=true` so `npm install <pkg>` keeps it that way; do not add ranges by hand.
- **`node --test` does not discover `*.spec.js`** with its default patterns. The npm scripts
  pass the glob `'src/**/*.spec.js'` explicitly; single quotes matter so Node expands it, not
  the shell.
- **MCP errors reach the client as `McpError`** with the message prefixed `MCP error -32603: `.
  Assert with `assert.match`, never `assert.equal`.
- **`callTool` results are `JSON.stringify`-ed by the server**, so a handler returning `'OK'`
  arrives as `text: '"OK"'` — quotes included.
- **`SubstackPost.getDraft()` calls `JSON.stringify` on `draft_body`**, so it must be handed an
  object. Passing a string double-encodes it; this was a real bug (#4).
- **HTTP goes through native `fetch`** — no HTTP client dependency. `fetch` does not reject on
  non-2xx, so `SubstackApi.handleResponse` is what turns a failing status into an error
  (`SubstackAPIException: <status> <statusText>`); it also serializes the body and sets
  `Content-Type` by hand, which axios used to do implicitly.

## Verifying the server actually works

Tests passing is not proof the binary runs. Drive the real entrypoint over stdio:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SUBSTACK_PUBLICATION_URL=https://test.substack.com SUBSTACK_SESSION_TOKEN=tok SUBSTACK_USER_ID=1 \
    timeout 5 node src/index.js
```

Note the process exits 0 immediately when stdin is at EOF — that is normal, not a crash, so
exit status alone tells you nothing. Diff this output before and after a refactor to prove the
protocol is unchanged.
