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

**The draft lifecycle is four verbs on one path.** `POST /drafts`, `PUT /drafts/:id`,
`POST /drafts/:id/publish`, `DELETE /drafts/:id` — all verified except publish, which cannot be
confirmed without making something public. Two things follow from `DELETE` being shared with
published posts:

**Publishing: the email flag is on the draft, not only in the request.** The bundle builds the call as
`post('/api/v1/drafts/' + id + '/publish').send({send: true, only_send: true})` — so the path and the
`send` key are real, and `only_send` means "email an already-published post without republishing it".
Two traps around it:

- **`share_automatically` does not exist.** It appears **zero** times in the bundle; the fork sent it.
  An unexpected parameter is a 400 on several of this API's endpoints, so an invented key is not free.
- **`should_send_email` on the draft is where the dashboard keeps the decision** — its serializer
  computes `dontSendEmail: !!email_sent_at || !should_send_email` — and it is **`true` by default** on
  a real draft. Whether the initial publish honours a body `send` or reads that field cannot be
  determined without publishing, and the ambiguity is dangerous in one direction only: a body `send`
  that turns out to be ignored mails the entire list. `publish_draft` therefore PUTs the intent to the
  draft *first* and passes `send` as well, so both possible behaviours agree. A failing PUT aborts —
  publishing after the intent failed to save is the scenario the write exists to prevent. it removes a live post just as readily, so `delete_draft` spends a read to refuse an
`is_published` target rather than exposing that reach behind a draft-shaped name. And `PUT` is
genuinely partial — a body carrying only `draft_title` changed that and preserved the body — so an
absent key must never be sent as null.

**There are two hosts, and they are not interchangeable.** The publisher surface is on the
publication and keyed by publication id; *your profile, your subscriptions, the reader inbox, the
Notes feed and comment threads* are on `substack.com/api/v1` and keyed by **user** id. Each answers
404 for the other's paths, which is why `SubstackApi.requestGlobal` exists as a sibling of `request`
rather than callers concatenating a base — the choice of host is part of the endpoint.

**The tag surface is `/publication/post-tag`, and `/post_tags` is a 404.** GET lists and POST creates
on the same path; `/post-tag/:uuid` is one tag and `/post-tag/settings` adds `navigationBarItem`.
Three measured traps:

- **Tag ids are UUIDs**, the only ids in this API that are not integers. A schema typed `z.number()`
  fails on contact.
- **`GET /post/:postId/tag` answers join rows** — `{id, publication_id, post_id, post_tag_id}` — with
  **no name and no slug**, and neither `GET /drafts/:id` nor `post_management/*` carries tags at all.
  So reading a post's tags means joining against the tag list; handed over raw it is a list of UUIDs
  the caller cannot interpret. Note `id` there is the *association's* own UUID, not the tag's.
- **Attaching a tag twice answers 400**, naming neither the post nor the tag, and the count does not
  change. `add_tag_to_post` checks first so the answer is `already_tagged` rather than a bare 400.

**Comments and Notes are the same entity**, which is why `src/api/substack/comment.js` serves both:
a Note is a comment with `type: 'feed'` and no `post_id`. Three of its fields are wrong by analogy
with the rest of this API, and were wrong in the fork this was ported from:

- The author is **flat** — `name`, `handle`, `photo_url` on the comment. There is no nested `user`.
- Replies are **`children_count`**. There is no `children` array to take `.length` of.
- There is **no `parent_id`**. Hierarchy is `ancestor_path`, a **dot-separated** chain of ancestor
  ids, root-first, empty at the top — verified at three depths: `''`, `'309007328'`,
  `'309007328.309403526'`. The parent is therefore the **last** segment. Reading the first names the
  thread root as every nested reply's parent, which is wrong only once a thread is three deep and
  silently correct before that.

`/post/:id/comments` answers `{comments, automod_hidden_comments}`; the second array is what automod
withheld and never appears in the first, so merging or dropping it turns "held" into "nobody
commented".

**There is a *second* comment shape, and it is the one you get back from writing.** `POST
/post/:id/comment` answers with the comment directly — no envelope — but carrying `children` (an
array) and `reactions` (an object) instead of `children_count` and `reaction_count`. Both paths run
through the same `summarizeComment`, so it reads the counts and falls back to the collections.
Verified alongside it: **`DELETE /api/v1/comment/:id` answers 200** and the comment leaves the post,
which is why `comment_on_post` is a write this server is willing to make.

**A restack, by contrast, cannot be undone.** `POST /restack/feed` is real and verified, and three
things about it were measured the hard way:

- **The body keys are camelCase** — `commentId`, `tabId` — unlike almost everything else here.
  Confirmed by elimination: `{post_id, tab_id}` answers `400 "Devi fornire postId o commentId"`, the
  API naming the keys it wanted.
- **Restacking a post does not work through it.** `{postId, tabId}` answers
  `404 "Post da Restack non trovato"` for a published post on the caller's own publication, so
  whatever that path needs is not an id from `list_posts`. `restack_item` therefore takes only a Note.
- **A restack has no id of its own.** It surfaces the *original* Note with `context: comment_restack`
  in the profile feed, so `DELETE /comment/:id` would target someone else's Note rather than the
  restack. Un-restacking is a UI toggle with no endpoint found in a full sweep of all 109 scripts on
  `substack.com` — `restack/feed` appears there exactly once, and only as the create path.

**Three endpoints return heterogeneous arrays, and only some entries carry content.** This is the
same silent-drop family as `columnView` and the export's columns, seen from the other side — here the
hazard is mapping straight through and *inventing* empty entries:

- `/subscriptions/all/v2` → `subscription`, `label` (a section header like "Paid"), `add_more`.
- `/reader/feed` and `/reader/feed/profile/:userId` → `comment` (a Note), `post`, `userSuggestions`.

Filter on the type, not on whether a field happens to be present: today's `label` has no `pub`, so a
presence check appears to work and stops working the moment Substack adds a type that carries one.

**Four more facts about the reader surface, each measured:**

- **`paused` is `null`, not `false`**, when a subscription is not paused, and a *free* subscription
  carries an `expiry` in the year 2121. So `paused === false` drops every active subscription, and a
  present expiry is not evidence of a paid term.
- **`/reader/posts` pages by `after`, a timestamp**, taken from the last `inboxItems` entry's
  `content_date`. Its own top-level `cursor` is always null.
- **Feed tab `name`s are localized** — they came back in Italian — so a tab is selected by `id`.
- **The Inbox and the feed attach `body_html` and `body_json` to every post.** An unprojected page of
  20 runs to hundreds of KB. Listings carry `truncated_body_text`; `/posts/by-id/:id` is how to read
  one in full, and it is the only endpoint that returns another publication's body.

`get_reader_post` leaves that body as **HTML** rather than converting it. Markdown would mean a new
dependency or a regex pass over markup, and a regex HTML converter mangles nested lists and embeds
*silently* — the same argument as `csv.js` reaching the opposite conclusion, because HTML is not a
bounded grammar and CSV is. An LLM reads HTML perfectly well.

**Deliberately not implemented, and why**, so it is not re-litigated: `create_note` and
`reply_to_note` need `playwright-extra` plus a stealth plugin to obtain a `cf_clearance` cookie and
get past Cloudflare bot management on `POST /comment/feed`. That is three heavy dependencies, a
browser download, a broken Docker image, and a technique that breaks on Cloudflare's next change.
Also skipped: `update_payment_settings` (paywall pricing from an LLM), deleting *published* posts,
and a hand-maintained `list_resources` catalog — a second tool list that can drift from `tools/list`.

**The forks are exhausted, and a re-survey costs more than it returns.** All eight were compared
against `main` again on 2026-08-07, after #18: five are zero-commit snapshots, `adamhwoodworth`'s
`fix-draft-body-double-encoding` is already merged as #4 (its two residual commits carry a `parseBody`
test this repo has in English *plus* the logging assertions), and `jcllobet`'s reader work went in
with #18. Only `jefflee1990710` still holds anything, and it is one coherent area rather than a list:
**account and publication settings** — `PUT /api/v1/publication` (`name`, `hero_text`, `copyright`,
`email_from_name`, `logo_url`) and `PUT substack.com/api/v1/user/profile` (`name`, `bio`, `photo_url`).
Per the fork these store an external `logo_url`/`photo_url` that does not render, so they likely need a
Substack-hosted asset first — which `upload_image` now produces (`POST /api/v1/image`, verified and
shipped; see the image contract below). Both settings writes are still unverified writes from the fork
that invented `share_automatically`, so neither ships without a live check first; they are open by
choice, not by oversight.

**Writes log their intent at `info` *before* the request**, not only their outcome —
`publish_draft.publishing`, `comment_on_post.posting`, `restack_item.restacking`, with the full text
where there is one. Nothing in this server can unpublish, delete a comment or undo a restack, so that
line is the only record that it happened.

**The post body has a contract, and `set_post_body` is where it lives.** `src/api/substack/document.js`
models the ProseMirror document in zod — a discriminated union over the fifteen node types observed in
the live archive, published as that tool's JSON Schema so a calling model reads the vocabulary from
`tools/list` instead of guessing. It is the only tool that publishes it: at roughly 21 KB, carrying it on
`create_draft_post` and `update_draft` too would more than double a `tools/list` that is 56 KB with one
copy. `create_draft_post`'s JSON branch runs the **same validator without publishing it**, which cost
nothing and closed the last route that accepted a body unchecked. Six measured facts shape it:

- **The code block is `highlighted_code_block`.** `python-substack` declares `codeBlock`, which is not
  what the editor writes and does not render. Both that and the legacy `code_block` are accepted —
  16 occurrences against 5 in the survey, so refusing the old one would refuse those posts.
- **`order` numbers a list, not `start`.** A list given `{start: 3}` is stored verbatim, answers 200 and
  renders from **1**; `{order: 3}` renders from 3. The editor writes both, so reading its own output
  suggests either would do — this is the **sixth** silent-ignore in this API and the only one this
  server nearly authored itself.
- **`type` is strict, `attrs` are loose**, in opposite directions on purpose. The editor writes
  `textAlign: null` on every block and `nodeId: null` on code blocks, so strict attrs would reject every
  real post; the discriminated union on `type` is what produces `Invalid discriminator value. Expected
  'paragraph' | 'heading' | …`, the only repair instruction an LLM gets. **A generic unknown-node branch
  was tried and rejected**: it keeps a malformed `heading` out but reports only the generic branch's
  error, so the caller never learns which field is wrong. Every observed type is enumerated instead,
  including three whose internals were never read — `digestPostEmbed`, `substack_mentions`,
  `directMessage` — as `looseObject`s that survive a round trip whole. `digestPostEmbed` alone is in 59
  of 60 sampled posts, so this is what makes read-modify-write possible at all.
- **Survey both publications before trusting the enumeration.** The first pass covered `implementing`
  only and missed `youtube2`, which is in 33 of 40 sampled `quickviewai` posts — `{videoId}`, no content.
  22 real posts across both now validate with no unknown node, no unknown mark and every required attr
  present.
- **A document may carry one `paywall`, and we are the only ones enforcing it.** Two are accepted with a
  200 and rendered as two "Paid content below this line" markers, leaving it undefined which one cuts
  the post. Since a `.refine()` does **not** survive into the published JSON Schema, the rule is repeated
  in the node's description or a model meets it only by failing.
- **The code-block `language` is a closed set that fails silently.** `auto` is the auto-detect sentinel,
  `plaintext` the plain-text value, and an unrecognised name renders as Plain Text with no error, so
  omitting the attr beats guessing.

**Images can be uploaded after all, and `upload_image` is how** — this once read "cannot be uploaded,
`POST /api/v1/image` hangs in all three encodings, do not implement." That record was wrong. Re-measured
live 2026-08-08 on `implementing.substack.com` from the authenticated dashboard: the endpoint answers
**200 in ~300ms**. The three earlier attempts (JSON, form-urlencoded, multipart) failed because they sent
the wrong *thing*, not for a header detail or a Cloudflare wall — the body is JSON `{image:
"data:<mime>;base64,…"}`, a **data URI**, built in the editor from `canvas.toDataURL()`. The response is
`{id, url, contentType, bytes, imageWidth, imageHeight}`, `url` on `substack-post-media.s3.amazonaws.com`
— the host every `image2.src` uses — and it renders through Substack's CDN (proven end to end on a real
draft: upload → `captionedImage` → PUT → the editor shows a `substackcdn.com/image/fetch/…` render).
Two measured facts shape the tool:
- **Substack server-fetches only its own S3 bucket.** An external URL passed as `image` answers
  `400 "Failed to fetch image"`, so `upload_image` downloads the URL itself and re-encodes it. That
  download is the one place this server fetches a caller-chosen host, so it is guarded: `http(s)` only,
  an SSRF block on private/loopback/link-local addresses *after* DNS resolution and re-checked on every
  redirect hop, an `image/*` content-type check (HEIC refused early, as the dashboard does), and a 10 MB
  cap that is **ours, not Substack's** — the bundle's `MAX_FILE_SIZE` could not be read from the minified
  source.
- **The data URI is elided in the logger, not just kept out of the tool's own lines.** `SubstackApi` logs
  every request body at info, so a real upload would put hundreds of KB of base64 on one line;
  `src/logger.js` truncates a `data:…;base64,` value to its prefix and omitted length. A post body, being
  prose, is still logged in full — the two are different in kind.

**Still unverified:** every live check used the browser session cookie, not `SUBSTACK_SESSION_TOKEN` in a
header. Equivalent in principle, unconfirmed through `SubstackApi` — the first thing to check if the tool
misbehaves against the real API.

**`set_post_body` returns a node tally, not `'OK'`**, because validation cannot report what was never
sent: a document with no paywall is exactly as valid as one with a paywall. This was measured — a model
asked for a paywall through a Markdown contract omitted it, produced valid Markdown, and the document it
rendered to passes this very schema. The tally is the caller's only way to see what landed.

**The descriptions are load-bearing and a test enforces them.** The published schema is the vocabulary,
so `document.spec.js` walks the whole converted schema and fails on any union branch without a
`description`, naming it. The walk is recursive on purpose: `list_item`, `image2` and `caption` are
reachable only nested, and an earlier top-level-only version left stripping every mark description green.

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
