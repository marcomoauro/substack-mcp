# Markdown post bodies — Design

Date: 2026-08-07
Status: **superseded** by `2026-08-07-post-body-contract-design.md`, same day, on measurement.

Two numbers ended it. **100% of 60 sampled published posts contain nodes Markdown cannot express** —
`button` in 60/60, `captionedImage` in 60/60 — so this design could not have reproduced a single real
post on this publication, and the "images are out of scope, they come later" call below was the whole
substance rather than the tail of it.

Worse, the safety net here did not hold. In a head-to-head run, a model given the Markdown contract
**degraded a button to a link and omitted a paywall entirely**, producing valid Markdown and an empty
`unsupported` list. `unsupported` can only report constructs Markdown *has* and Substack lacks; what
Markdown *lacks* is substituted upstream, in the model, and arrives as healthy prose. That post would
have published with its paid section public and nothing in the log to say so.

What survives is the measurement, kept here because it was real: the renderer prototype reproduced a
hand-written document byte for byte, and Markdown was 5.8× cheaper in emitted bytes. It lost on
coverage, not on fidelity or cost.

## Goal

Let a caller write a post body in **Markdown** and have this server translate it into the
ProseMirror document Substack stores, so that headings, emphasis, links, lists, quotes, code and
rules become reachable without hand-writing JSON.

Two tools gain it: `create_draft_post`, whose `body` currently produces flat paragraphs only, and
`update_draft`, which today **cannot change a body at all** — it accepts `draft_title`,
`draft_subtitle` and `audience`, so a post's body can be set once, at creation, and never again.

## Why this is the gap worth closing

`parseBody` in `src/tools/create_draft_post.js` has exactly two branches: a string that parses as
JSON with `type: 'doc'` passes through untouched, and anything else is split on `/\n+/` into
paragraphs. So `## Introduction` reaches the published post as the literal characters `## `, and
`**bold**` keeps its asterisks. Everything richer requires the model to emit ProseMirror JSON by
hand — as a *string*, doubly escaped — using node names it cannot discover and that are not even
internally consistent (`bullet_list` with an underscore, `highlighted_code_block` likewise, but
`captionedImage` in camelCase). A wrong name is not an error: the draft is created and the content
is silently mangled.

`src/api/substack/SubstackPost.js` already carries a fluent builder — `paragraph`, `heading`,
`bulletList`, `orderedList`, `bold`, `italic`, `marks`, `captionedImage`, `paywall`, buttons. It is
**unreachable**: its own spec exercises it, but no tool calls anything beyond `setTitle`,
`setSubtitle` and `setBody`. The vocabulary is in the repository already; what is missing is the
road from text a model writes naturally to that vocabulary.

## Verified facts

Everything below was measured on 2026-08-07 against a live publication
(`implementing.substack.com`, scratch draft `210218832`) by composing each construct in the real
editor and reading back `GET /api/v1/drafts/:id`. **The shapes are what Substack itself writes**,
not inference from a third-party client — and three of them contradict the sources this design
started from.

### Node shapes as the editor produces them

| Node | Attrs |
|---|---|
| `heading` | `{textAlign: null, level: N}` |
| `paragraph` | `{textAlign: null}` |
| `bullet_list` | none |
| `ordered_list` | `{start: 1, type: null, order: 1}` |
| `list_item` | none; contains a `paragraph` |
| `blockquote` | none; contains `paragraph`s |
| `horizontal_rule` | none |
| `highlighted_code_block` | `{language: '<value>', nodeId: null}`; content is a single `text` node |

Marks: `strong`, `em`, `code` and `strikethrough` carry no attrs. `link` carries **four**:
`{href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null}`.

### Corrections to the sources

- **The code block is `highlighted_code_block`, not `codeBlock`.** `python-substack`'s `nodes.py`
  declares `CODE_BLOCK = "codeBlock"`; the editor writes `highlighted_code_block`. Following that
  library here would have produced a node Substack does not render.
- **The `link` mark is not `{href}` alone.** Both `python-substack` and `SubstackPost.js` build only
  `href`. The editor writes `target` and `rel` as well.
- **`ordered_list` does carry attrs.** `python-substack` omits them; `SubstackPost.js` writes
  `{start: 1, order: 1}` and is missing `type: null`.
- **`strikethrough` is real**, confirming the one mark `python-substack` listed that no other source
  did.

### What the API does with what we send

`PUT /api/v1/drafts/:id` **accepts `draft_body`** (200) and **stores it verbatim**. It normalises
nothing: a link given only `href` stays that way, a `heading` without `textAlign` stays without it,
an `ordered_list` without attrs keeps no attrs, and a `language` outside the accepted set is kept as
given. The server is a dumb store; the editor is the only validator.

Reloading the editor on those minimal shapes renders **all of them correctly** — link, heading,
ordered list, rule and code block. So the renderer may emit the minimal form, and should: every
attr we invent is an attr we can get wrong, and `target`/`rel` are the editor's presentation choice
rather than something a document requires.

### The code-block language is a closed set that fails silently

`language: 'sh'` renders, but the editor's own dropdown reports it as **Plain Text** — the value is
unrecognised and quietly ignored, with no highlighting and no error. This is the *fifth* member of
the silent-ignore family already documented in CLAUDE.md (`columnView`, the export's columns,
`get_analytics` extras, `get_post_stats.order_by`).

The editor bundle uses `auto` as the auto-detect sentinel and `plaintext` for Plain Text, with
lowercase highlight.js-style values. The dropdown lists a subset (JavaScript, TypeScript, JSX, TSX,
Python, CSS, HTML, JSON, Bash, Markdown, SQL, YAML, Go, Rust, Java, C, C++, C#…) while the bundle
also references `php`, `dockerfile`, `xml`, `bash` and `shell` — so the accepted set is wider than
the menu, and the full table must be lifted from the bundle at implementation time rather than
guessed.

### Editor input rules, for context

Typing `#`…`######`, `**x**`, `*x*`, `` `x` ``, `~~x~~`, `- `, `1. `, `> ` and ``` in the editor all
convert. `[text](url)` does **not** — the editor has no link input rule. This says nothing about
what we may send; it is why the link shape had to be read from an existing published post instead.

## The dependency: `marked`

`marked@18.0.9`, **zero transitive dependencies**. `markdown-it` brings six, and this repository has
two runtime dependencies in total (`@modelcontextprotocol/sdk`, `zod`), so the difference is
material. Only `marked.lexer()` is used — the token tree — never the HTML renderer.

Writing the parser by hand was considered and rejected. CLAUDE.md's own criterion, set by `csv.js`
(hand-written, ~40 lines) against leaving HTML alone, is whether the grammar is bounded. CommonMark
is not: emphasis resolution and nested-list continuation are where hand-rolled parsers fail, and
they fail *silently*, mangling a post rather than throwing. Markdown belongs on the HTML side of
that line.

Token shapes, confirmed by running the lexer: blocks are `heading{depth}`, `paragraph`,
`list{ordered, start, items}`, `blockquote`, `code{lang, text}`, `hr`, `space`; inline are `text`,
`strong`, `em`, `codespan`, `link{href}`, `del`. Both blocks and inlines nest through `tokens`, and
a `list_item`'s inline content sits one level deeper, wrapped in a `text` token that itself carries
`tokens`.

## Architecture

A new module, `src/api/substack/markdown.js`, sitting beside `csv.js` and filling the same role: a
bounded translation with no I/O, no env reads and its own colocated spec. It exports one pure
function.

```
markdownToDoc(markdown) → {doc: {type: 'doc', content: [...]}, unsupported: string[]}
```

**It does not go through `SubstackPost`'s builder.** That builder mutates
`draft_body.content[length - 1]` by index, which cannot express nesting: a `list_item` holding a
`paragraph` holding marked text is three levels deep and index access sees one. A pure
token-to-node function nests naturally and is testable without a draft. `SubstackPost` keeps
receiving a finished document through `setBody`, exactly as today.

### The mapping

| Markdown | Node emitted |
|---|---|
| `#`…`######` | `heading` + `attrs.level` |
| paragraph | `paragraph` |
| `**x**` / `*x*` / `` `x` `` / `~~x~~` | mark `strong` / `em` / `code` / `strikethrough` |
| `[x](u)` | mark `link` + `attrs.href` |
| `- x` | `bullet_list` › `list_item` › `paragraph` |
| `1. x` | `ordered_list` › `list_item` › `paragraph`, `attrs.start` only when not 1 |
| `> x` | `blockquote` › `paragraph` |
| ` ```lang ` | `highlighted_code_block` + `attrs.language` when the language maps |
| `---` | `horizontal_rule` |

Minimal attrs throughout: no `textAlign`, no `target`/`rel`, no `nodeId` — all verified to render.

A fence whose language does not map emits the node **without** `attrs.language`, so it auto-detects
rather than carrying a value the editor will discard. The dropped language is reported (below), not
swallowed.

Single newlines inside a paragraph are normalised to a single space, so no `text` node ever contains
`\n`. Whether Substack treats an embedded newline as a space or a break was not measured, and
normalising avoids depending on the answer.

### Nothing is dropped in silence

Any construct the renderer cannot map is named in `unsupported`, which the tools return alongside
their result — GFM tables, raw HTML blocks, images, hard breaks, and unmapped code languages. This
is the same hazard CLAUDE.md documents five times over, seen from the side where *we* would be the
ones creating it: a table that vanishes reads as "the model forgot the table", not as "the server
does not support tables".

Flat strings rather than structured entries, because the consumer is a language model reading a
result, and `'table'` or `'code language "sh"'` needs no schema to interpret.

## Tool surface

`create_draft_post.body` keeps its type and its escape hatch: a string that parses as a
ProseMirror document still passes through untouched, and everything else is now Markdown rather
than flat paragraphs. The description states both.

`update_draft` gains an optional `body`, rendered by the same function. It is named `body` and not
`draft_body` deliberately: that tool otherwise uses wire names (`draft_title`, `draft_subtitle`)
because there the value *is* what goes on the wire, whereas here the wire carries a serialized
document — calling it `draft_body` would invite a caller to pass exactly that. The existing
"no fields to update" guard and its message grow to include it.

Both tools return `unsupported` when it is non-empty, and omit it otherwise.

## Behaviour changes to declare

- **A single newline no longer starts a paragraph.** Today `/\n+/` splits on one; in Markdown a lone
  newline continues the paragraph. The new behaviour is the correct one, and
  `create_draft_post.spec.js` pins the old one in a test named "a single newline also starts a new
  paragraph" — that test is rewritten, not quietly adjusted, and its CHARACTERIZATION comment
  updated in the same commit.
- **`*`, `#`, `_` and `` ` `` are now interpreted.** Prose containing them changes meaning; a caller
  wanting the literal character escapes it. This is the cost of Markdown by default, and it is
  stated in the `body` description rather than discovered.

## Testing

`markdown.spec.js`, colocated, table-driven per construct: each of the nine mappings, marks nested
inside list items and blockquotes, adjacent and overlapping marks, an ordered list with a non-1
start, a fence with a mapped language, a fence with an unmapped one, and each `unsupported` entry.
Plus the boundaries `parseBody` already covers — empty string, surplus blank lines, valid JSON that
is not a document, malformed JSON.

Per CLAUDE.md, **no new test is trusted on a first green run**: each is confirmed by breaking the
source on purpose — dropping a mark, renaming `highlighted_code_block`, removing the `unsupported`
push — and the mutation is grepped for before the run, since a regex that fails to match leaves the
file untouched and reads exactly like a test asserting nothing.

Tool-level tests keep their MSW shape and assert on the `draft_body` actually sent.

## Verification after implementation

The same live check that produced the facts above, run against the renderer's own output: PUT a
document containing every construct into a scratch draft, reload the editor, confirm each renders,
then remove the draft. Two things this catches that a unit test cannot — a node name that is right
in the spec and wrong in the code, and a language value that maps to nothing.

## Out of scope

Images (they need the image-upload endpoint, whose host the two available sources disagree about and
neither verifies), LaTeX, footnotes, poetry, polls and paywall markers. The editor's "More" menu
lists each of those by name, so they exist — but their node shapes were not read, and a name in a
menu is not a schema.

Callouts and pullquotes stay out for a stronger reason: `python-substack` declares `calloutBlock`
and `pullquote`, and **neither appears in that menu**. Given that the same file was wrong about
`codeBlock`, they are unverified claims rather than known nodes, and adopting them on that authority
is the mistake this design already caught once.

## Open items

The code-block language table. Its existence and its failure mode are established; the specific
label-to-value pairs must be read out of the editor bundle during implementation, and the fallback
when a fence language is absent from it is already decided — omit the attr, report the language.
