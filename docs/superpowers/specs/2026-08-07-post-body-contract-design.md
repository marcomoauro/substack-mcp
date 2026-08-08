# A validated contract for the post body — Design

Date: 2026-08-07
Status: approved
Supersedes: `2026-08-07-markdown-body-design.md`

## Goal

Give the post body a real contract: the Substack ProseMirror document, modelled in zod, published as
the tool's own JSON Schema so the calling model reads the node vocabulary in-band, and validated on
the way in so a wrong node name is an error rather than a mangled post.

Today there is no contract at all. `create_draft_post.body` is a string: a value that parses as JSON
with `type: 'doc'` is forwarded **unvalidated**, and everything else is split on `/\n+/` into flat
paragraphs. So the only route to a structured post is the unvalidated one, and `update_draft` cannot
touch a body at all.

## The measurements this rests on

Two head-to-head runs on 2026-08-07, plus a survey of the live publication. Everything below is
measured, not argued.

### What the publication actually contains

60 published posts sampled across the archive (offsets 0, 50, 100, 200, 400, 700), counting real
nodes in `draft_body`:

- Markdown-expressible: `paragraph` 782, `heading` 244, `horizontal_rule` 121, `list_item` 97,
  `blockquote` 55, `bullet_list` 31, `ordered_list` 1. Marks: `strong` 195, `link` 126, `em` 25,
  `code` 7 — and `strikethrough` **zero**.
- Not Markdown-expressible: `captionedImage` 201, `image2` 201, `button` 76, `digestPostEmbed` 60,
  plus `paywall`, `substack_mentions`, `directMessage`, `caption`.

**60 posts out of 60 contain at least one node Markdown cannot produce.** `button` in 60/60,
`captionedImage` in 60/60, `digestPostEmbed` in 59/60.

Two facts fall out of the same tally. `code_block` (16 occurrences) and `highlighted_code_block` (5)
are **both in live use** — older posts carry the former, the current editor writes the latter — so
the schema must accept both. And a `strikethrough` mark this publication has never used does not
need designing for.

### Head-to-head: five briefs, two contracts, ten fresh models

Each model saw only its own contract and its own brief — no design context. Scoring runs on the
**final document**, identically for both, by predicates over the produced nodes; the harness was
mutation-tested first and all six deliberate corruptions turned a check red.

| Brief | Markdown | Document | bytes (md) | bytes (doc) |
|---|---|---|---|---|
| Plain prose | 5/5 | 5/5 | 359 | 1,520 |
| Rich formatting | 9/9 | 9/9 | 685 | 3,241 |
| Code-heavy | 7/7 | 7/7 | 607 | 3,020 |
| Substack-native | **4/8** | 8/8 | 402 | 1,659 |
| Structural edge cases | 5/5 | 5/5 | 361 | 4,462 |
| **Total** | **30/34** | **34/34** | 2,414 | 13,902 |

- **The document validated 5/5 on the first attempt, zero repair rounds.** A 16 KB published schema
  is enough for a model to get nested lists, `ordered_list` with `start: 3`, a link inside a list
  item, a blockquote containing a list, a paywall, a button and a captioned image right first time.
  (That trial ran against a 16 KB prototype; the shipped schema is 20.3 KB, richer in descriptions.)
- **Where both can express a construct the result is semantically identical** — `em` on exactly
  "not", `code` on exactly `API_KEY`, `strong` on "Boring", the link on the intended words, all three
  code blocks with matching languages and lengths, and a `${API_KEY:?…}` shell guard intact.
- The document costs **5.8× more bytes**, and the ratio tracks structure rather than length: 4.2× on
  plain prose, **12.4×** on the structural brief.

### The failure that decided it

On the Substack-native brief the Markdown model degraded the button to `[Subscribe](%%checkout_url%%)`
and dropped the paywall. The output was valid Markdown, it rendered to a document that **passes this
very schema**, and `unsupported` came back **empty**.

That is the whole argument. A report of unsupported constructs can only name what Markdown *has* and
Substack lacks. What Markdown *lacks* gets substituted upstream, inside the model, and reaches us as
healthy prose. The post publishes with its paid section public and nothing anywhere says so — the
exact silent-drop class CLAUDE.md documents five times over, except authored by us.

### What naive strictness would cost

`digestPostEmbed` sits in 59 of 60 real posts. A schema modelling only the nodes a *writer* needs
would therefore **reject 59 of 60 real documents**, killing any read-modify-write flow on the first
try. The survey is what makes this fixable rather than a trade-off: it enumerates every type in use,
so all of them get modelled and nothing has to be waved through.

## Architecture

### A dedicated tool, so the schema is published once

`set_post_body(draft_id, body)`. Creation and body-writing become separate verbs, and the schema is
carried by one tool instead of two — publishing it on both `create_draft_post` and `update_draft` would
double its cost for every session, including those that never write a post.

**The finished schema publishes at roughly 21 KB** (20,342 bytes when this was written, 21,094 after the
`order` attribute was added later on the branch), measured on the implemented module rather than on the
prototype that suggested 16 KB: the extra four node types and the descriptions on every branch account
for the difference. Against a `tools/list` of 34.7 KB before this work, one copy is a ~59% increase and
two would have been ~117%.

It PUTs `draft_body` to `PUT /api/v1/drafts/:id`, verified to accept it and to store it **verbatim**:
no normalisation, no filled-in defaults. The server is a dumb store and the editor is the only
validator, which is why the validation has to live here.

`src/api/substack/document.js` holds the schema and nothing else — no I/O, no env reads — beside
`csv.js` and in the same spirit: one bounded translation with its own colocated spec.

### One validator, two doors — and the second door does not pay for it

`create_draft_post.body` keeps its type and its plain-text behaviour, but its JSON branch stops being
a hole: the parsed value is validated **against the same schema**, and the same error message comes
back. The schema is not published on that tool, so the cost is zero and the protection is total.

This is the one place where "validate without publishing" is exactly right: publishing teaches a
model the vocabulary — worth 16 KB where structure is authored — while validating protects even where
nothing was taught. Nothing new can enter this server unvalidated.

### Node coverage

Modelled, with their verified shapes: `paragraph`, `heading`, `bullet_list`, `ordered_list`,
`list_item`, `blockquote`, `highlighted_code_block`, `code_block` (legacy, accepted not encouraged),
`horizontal_rule`, `captionedImage`/`image2`/`caption`, `button`, `paywall`. Marks: `strong`, `em`,
`code`, `strikethrough`, `link`.

Then two deliberate choices, each with its own reason:

- **`attrs` on a known node are permissive** (`looseObject`), so `textAlign: null` and `nodeId: null`
  survive a round trip untouched. Required attrs still guard: a heading missing `level` is an error,
  and a typo'd `levl` fails on the *absent* `level` rather than passing.
- **Every node type observed in the live archive is modelled**, so there is no generic passthrough
  branch. The 60-post survey enumerates the whole set: `paragraph`, `heading`, `text`, `blockquote`,
  `bullet_list`, `ordered_list`, `list_item`, `horizontal_rule`, `hard_break`, `code_block`,
  `highlighted_code_block`, `captionedImage`, `image2`, `caption`, `button`, `paywall`,
  `digestPostEmbed`, `substack_mentions`, `directMessage`, `youtube2`. The three whose internals were never read —
  `digestPostEmbed`, `substack_mentions`, `directMessage` — are modelled as a `looseObject` on their
  literal `type`: everything else passes through preserved, which is enough for a round trip and
  honest about knowing no more than that.

  **A generic "unknown node" branch was tried and rejected on measurement.** Wrapping the union as
  `z.union([known, looseObject({type: string})])` does keep a malformed `heading` out — but the only
  issue reported becomes the generic branch's, so the caller is told "this is a modelled node, match
  its shape" and never *which* field is wrong. That trades away the exact thing the discriminated
  union was chosen for. Enumerating instead keeps every message sharp, and a genuinely new Substack
  node then fails **loudly**, naming the types it could have been — visible, which is the opposite of
  the silent drop this design exists to prevent.

  **The enumeration had to be widened once already, which is the honest measure of this risk.** The
  first survey covered `implementing` only. Sampling the second publication, `quickviewai`, found
  `youtube2` — `{videoId}`, no content — in **33 of 40** posts, so the union as first drafted would
  have blocked a round trip on most of that archive. Both publications are now covered.

  The residual risk is stated rather than engineered away: a node neither publication has used — a
  footnote, LaTeX, a poll, a subscribe widget — still blocks a round trip until its shape is read off
  a live draft and added. Adding one is a line in the union, and the failure names the alternatives
  rather than going quiet.

### At most one paywall, and we are the only ones enforcing it

A document may carry **one** `paywall` node, enforced by a `.refine()` on the document. A refinement
does **not** survive into the published JSON Schema — verified — so the rule is also stated in the
`paywall` node's own `.describe()`, or a model would meet it only by failing. Measured on 2026-08-07: a body with two paywalls is
accepted by `PUT /api/v1/drafts/:id` with a **200**, stored with both, and the editor then renders
**both** as "Paid content below this line" — so neither the API nor the editor guards this, and which
of the two actually cuts the post is undefined.

So this constraint does not mirror a server rule; it is a `.refine()` on the document that will be the
only check in existence. That makes it worth having rather than presumptuous: two paywalls is not a
style preference, it is an ambiguous post, and the failure is invisible until a paying subscriber sees
what a free one also saw.

The line this stays on: the schema encodes **Substack's rules**, not editorial taste. Levels 1–6, a
`caption` only inside a `captionedImage`, `href` required on a link, one paywall — all properties of
the format. Requiring that a post *have* a heading, an image or a paywall would be our preference
wearing the format's clothes, and would reject a perfectly good three-paragraph post.

### The result echoes what was stored

Validation cannot deliver "the post came out the way we wanted", and the experiment behind this design
proves it: the Markdown model produced a document that **passes this very schema** and had lost its
paywall. Nothing was illegal; something was missing, and legality has no opinion about missing.

So `set_post_body` returns the shape of what it stored, not `'OK'`:

```
{draft_id, nodes: {paragraph: 12, heading: 3, captionedImage: 1, button: 1, paywall: 1,
 digestPostEmbed: 1}}
```

A caller that asked for a paywall can see whether there is one. This is the same reasoning that makes
`create_draft_post` return `draft_id` rather than `'OK'` — the log goes to stderr where the model
cannot read it, so the result is the only channel back. A node tally costs a few lines and closes
precisely the gap validation is blind to.

### The error messages

The discriminated union is what makes the errors worth publishing. Measured on the real schema:

```
content.0.type: Invalid discriminator value. Expected 'paragraph' | 'heading' | 'bullet_list' | …
content.0: Unrecognized key: "attrs"
content.0.content.0.marks.0.attrs: Invalid input: expected object, received undefined
```

Exact path, and the valid alternatives named. A plain `z.union` gives none of that, so the union must
stay discriminated even where recursion makes it awkward — verified working through zod's getter form,
including a two-deep nested list, and converting to draft-7 with a self-contained `definitions` block.

## Testing

`document.spec.js`, colocated and table-driven: every modelled node, marks nested inside list items
and blockquotes, `attrs` passthrough, each of the three opaque nodes accepted, a node type
outside the enumeration rejected with the alternatives named, a second `paywall` rejected, the node tally counting what was stored, and the four error messages above pinned
by wording — `src/server.spec.js` already pins validation wording on
purpose, because a degraded message breaks nothing by itself and only an assertion catches it.

Two fixtures earn their place: a **real post document** pulled from the publication, asserting it
validates and that `digestPostEmbed` is reported rather than rejected; and the five briefs' documents
from this experiment, asserting the shapes a model actually produces stay accepted.

Per CLAUDE.md no new test is trusted on a first green run — each is confirmed by breaking the source,
with the mutation grepped for before the run.

## Behaviour changes to declare

- `create_draft_post`'s JSON branch now **rejects** an invalid document instead of forwarding it. The
  characterization test asserting a document "is passed through untouched" is rewritten, and its
  comment updated in the same commit.
- `create_draft_post.body` stays plain-text-to-paragraphs. It is *not* becoming Markdown: that design
  is superseded, and the `/\n+/` split keeps its current behaviour, single newlines included.

## Verification after implementation

`set_post_body` against a scratch draft carrying every modelled node, then the editor reloaded to
confirm each renders — the same loop that produced the node shapes, and the only thing that catches a
name right in the spec and wrong in the code. Then a real post read, validated, and written back
unchanged, asserting the round trip preserves what it passed through.

### What the 16 KB is actually made of

Measured during the Task 1 review: the SDK converts with `z4mini.toJSONSchema(schema, {target, io})`
and passes no `reused` option, so shared subtrees are **inlined**, not referenced. On a two-node
schema that already means 80% of the published bytes are two verbatim copies of the inline-content and
mark union. Passing `reused: 'ref'` would shrink it, but `registerTool` gives no way to reach that
option, and the names it generates are machine-made (`__schema0`…).

So the 16 KB figure is not a ceiling that better factoring would lower — it is what this schema costs
through the SDK, and each further node carrying inline content adds roughly another 1.7 KB. Worth
knowing before anyone tries to optimise it, and worth re-measuring rather than assuming if the node
list grows much beyond the current fifteen.

## Limits

**Images can be referenced but not uploaded**, and this is the design's sharpest practical limit:
`captionedImage` appears in 60 of 60 sampled posts, while `image2.src` must already point at a
Substack-hosted asset. A post that reuses an existing image works; a post that needs a new one does
not.

An attempt to settle the upload endpoint on 2026-08-07 **failed, and the failure is the finding.**
`POST /api/v1/image` on the publication host was tried three ways — `{image: <data URL>}` as JSON (the
fork's shape), as `application/x-www-form-urlencoded` (python-substack's shape, since `requests`'
`data=` is form-encoded rather than JSON), and as `multipart/form-data`. **All three hang.** The
browser's own network log shows the request pending indefinitely: the server accepts the connection and
never answers, past a minute. A cross-origin attempt at `substack.com/api/v1/image` never settled
either.

So neither source's claim is confirmed, and the endpoint as both describe it does not respond to a real
logged-in session. This belongs beside `audience_insights/location` and `visitor_sources` — documented
endpoints that do not work — except that here the documentation is a third party's rather than
Substack's own. **Do not implement an upload from either signature.**

Settling it means watching the editor upload something itself, which is a different kind of work from
replaying a request: it needs a file reaching a file picker or a paste event. Deliberately not folded
into this design.

Nodes that stay out until their shape is read off a live draft: LaTeX, footnotes, polls, poetry,
recipes, the subscribe widget, and the financial chart — all names in the editor's "More" menu, none
with a shape anyone has verified. `calloutBlock` and `pullquote` stay out for a stronger reason: they
come only from `python-substack`, the file that was wrong about `codeBlock`, and appear in that menu
nowhere.

## Open items

The code-block language table. `auto` is the auto-detect sentinel, `plaintext` the plain-text value,
and values are lowercase highlight.js names of which the dropdown shows a subset — the bundle also
references `php`, `dockerfile` and `xml`. An unrecognised value renders as Plain Text **silently**, so
the pairs are to be lifted from the editor bundle rather than guessed, and the schema describes the
common ones without pretending to be exhaustive.
