# Validated Post Body Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Substack post body a real contract — a zod-modelled ProseMirror document, published as a tool's own JSON Schema and validated on the way in — so a wrong node name is an error instead of a silently mangled post.

**Architecture:** One new pure module, `src/api/substack/document.js`, holds the schema (a discriminated union over every node type observed in the live archive, with permissive `attrs`) plus a node tally. One new tool, `set_post_body`, publishes that schema and PUTs `draft_body`. `create_draft_post`'s existing JSON branch — today forwarded unvalidated — starts using the same validator without publishing the schema, so it costs nothing and protects fully.

**Tech Stack:** Node 24 for development / Node 22 floor (`src/` must use nothing newer than 22 offers), ESM, zod 4.4.3, `@modelcontextprotocol/sdk` 1.30.0, `node:test` + `node:assert/strict`, MSW for HTTP mocking.

**Spec:** `docs/superpowers/specs/2026-08-07-post-body-contract-design.md`

---

## Before you start

Read `CLAUDE.md` in full. The conventions it sets are not optional here, and three matter constantly:

- **Everything in the repository is written in English** — code, comments, test names, commit messages. The chat language does not change this.
- **Style:** two-space indent, semicolons, single quotes in code (double in imports), compact object literals (`{a: 1}` not `{ a: 1 }`).
- **Tool schemas are `z.strictObject`, never `z.object`.** The validation message is the only feedback an LLM gets to repair a call.

**Test output shape depends on the Node version.** On 24 it is the spec reporter (`ℹ pass`, failures `✖`); on the 22 floor it is TAP (`# pass`, failures `not ok`). Grep for both or a green run reads as a broken command:

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

**A new test that passes on the first run has proven nothing.** Every task below has a step that breaks the source on purpose and confirms the test goes red. Grep the file for a marker first to check the mutation actually landed — a `sed` regex that fails to match leaves the file untouched and reads exactly like a test asserting nothing.

Baseline before you begin: 590 tests passing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/api/substack/document.js` | **Create.** The post-body schema and `summarizeNodes`. Pure: no I/O, no env reads, no logging. Sits beside `csv.js` for the same reason — one bounded translation with its own colocated spec. |
| `src/api/substack/document.spec.js` | **Create.** Schema behaviour: every node, every mark, the paywall cap, error-message wording, the tally. |
| `src/tools/set_post_body.js` | **Create.** The tool: validates, PUTs `draft_body`, returns the tally. |
| `src/tools/set_post_body.spec.js` | **Create.** Tool behaviour against MSW. |
| `src/server.js` | **Modify.** One import and one registry entry. |
| `src/tools/create_draft_post.js` | **Modify.** Its JSON branch calls the shared validator. |
| `src/tools/create_draft_post.spec.js` | **Modify.** Rewrite the characterization test that pins unvalidated passthrough. |
| `src/server.spec.js` | **Modify.** Assert `set_post_body` is registered and publishes a usable schema. |
| `CLAUDE.md` | **Modify.** Record the contract and the measured facts behind it. |

`document.js` will end up around 200 lines and that is its whole job. Do not put the tool's logging or the API call in it.

**Two conventions every node added in Tasks 2–4 must follow**, both established by the Task 1 review:

- **Every node and mark carries a `.describe()`.** The schema is published as a tool's JSON Schema and
  the descriptions are how a calling model learns the vocabulary — a node without one is invisible to
  the caller. Task 1 adds a test that walks the whole converted schema and asserts every branch of
  every union, **nested ones included**, carries a description; a new node without one **fails the
  suite** and is named in the assertion. That is deliberate, and the walk has to be recursive because
  `list_item`, `image2` and `caption` are reachable only from inside another node, never as a
  top-level branch.
- **Pin what you add.** Before committing, mutate the thing you just wrote — swap a `strictObject` for
  `z.object`, drop a required field, widen a bound — grep to confirm the mutation landed, and check a
  test goes red. The Task 1 review found three surviving mutants in code that looked well tested.

---

## Task 1: The document module — marks, text, paragraph, heading

**Files:**
- Create: `src/api/substack/document.js`
- Create: `src/api/substack/document.spec.js`

- [ ] **Step 1: Write the failing test**

Create `src/api/substack/document.spec.js`:

```js
import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {postBodySchema} from './document.js';
import {setTestEnv} from '../../../test/helpers/env.js';

// setTestEnv is called even though this module reads no env var of its own: CLAUDE.md requires it
// from every spec whose subject could log, and it keeps the reporter clean if that ever changes.
let restoreEnv;
before(() => { restoreEnv = setTestEnv(); });
after(() => restoreEnv());

const doc = (...content) => ({type: 'doc', content});
const text = (value) => ({type: 'text', text: value});
const parse = (value) => postBodySchema.safeParse(value);
const issues = (value) => parse(value).error.issues.map(i => `${i.path.join('.')}: ${i.message}`);

describe('postBodySchema — paragraphs and text', () => {
  test('accepts an empty document', () => {
    assert.equal(parse(doc()).success, true);
  });

  test('accepts a paragraph of plain text', () => {
    assert.equal(parse(doc({type: 'paragraph', content: [text('hello')]})).success, true);
  });

  test('accepts a paragraph with no content at all', () => {
    assert.equal(parse(doc({type: 'paragraph'})).success, true);
  });

  test('rejects a document whose type is not doc', () => {
    assert.equal(parse({type: 'paragraph', content: []}).success, false);
  });

  // The editor writes attrs: {textAlign: null} on every paragraph and heading. A strictObject on
  // attrs would reject every real post, so attrs are loose and unknown keys survive verbatim.
  test('preserves attrs the schema does not model', () => {
    const result = parse(doc({type: 'paragraph', attrs: {textAlign: null}, content: [text('x')]}));

    assert.equal(result.success, true);
    assert.deepEqual(result.data.content[0].attrs, {textAlign: null});
  });
});

describe('postBodySchema — marks', () => {
  for (const type of ['strong', 'em', 'code', 'strikethrough']) {
    test(`accepts the ${type} mark`, () => {
      const node = {type: 'text', text: 'x', marks: [{type}]};

      assert.equal(parse(doc({type: 'paragraph', content: [node]})).success, true);
    });
  }

  test('accepts a link mark carrying an href', () => {
    const node = {type: 'text', text: 'x', marks: [{type: 'link', attrs: {href: 'https://example.com'}}]};

    assert.equal(parse(doc({type: 'paragraph', content: [node]})).success, true);
  });

  test('preserves the target and rel the editor adds to a link', () => {
    const attrs = {href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow'};
    const result = parse(doc({type: 'paragraph', content: [{type: 'text', text: 'x', marks: [{type: 'link', attrs}]}]}));

    assert.deepEqual(result.data.content[0].content[0].marks[0].attrs, attrs);
  });

  test('rejects a link mark with no href, naming the missing attrs', () => {
    const node = {type: 'text', text: 'x', marks: [{type: 'link'}]};

    assert.match(issues(doc({type: 'paragraph', content: [node]})).join(' '), /marks\.0\.attrs/);
  });

  // A mark is not a node. A model that emits {type: 'strong'} where a text node belongs gets told so.
  test('rejects a mark used as a node', () => {
    assert.equal(parse(doc({type: 'paragraph', content: [{type: 'strong', text: 'x'}]})).success, false);
  });
});

describe('postBodySchema — headings', () => {
  test('accepts levels 1 to 6', () => {
    for (let level = 1; level <= 6; level++) {
      assert.equal(parse(doc({type: 'heading', attrs: {level}, content: [text('T')]})).success, true, `level ${level}`);
    }
  });

  test('rejects level 7', () => {
    assert.equal(parse(doc({type: 'heading', attrs: {level: 7}, content: [text('T')]})).success, false);
  });

  test('rejects a heading with no level', () => {
    assert.match(issues(doc({type: 'heading', content: [text('T')]})).join(' '), /attrs/);
  });

  // The whole reason the union is discriminated rather than a plain z.union: the message names the
  // alternatives, which is a repair instruction rather than a complaint.
  test('names the valid node types when the type is unrecognised', () => {
    const message = issues(doc({type: 'codeBlock', content: []})).join(' ');

    assert.match(message, /Invalid discriminator value/);
    assert.match(message, /'paragraph'/);
    assert.match(message, /'heading'/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/api/substack/document.spec.js 2>&1 | tail -20
```

Expected: failure resolving `./document.js` — `Cannot find module`.

- [ ] **Step 3: Write the module**

Create `src/api/substack/document.js`:

```js
import {z} from "zod";

// The Substack post body, as a ProseMirror document.
//
// Every node name and attr shape here was read off a live draft or a live published post on
// 2026-08-07, never taken from a third-party client — `python-substack` declares the code block as
// `codeBlock`, which Substack does not render. See the design spec for the survey behind the
// enumeration: 60 published posts, every node type in use counted.
//
// Two rules govern how strict this is, and they pull in opposite directions on purpose:
//
//  - `type` is strict. It is a discriminated union so an unrecognised node is rejected with the
//    valid alternatives named, which is the only feedback an LLM gets to repair the call.
//  - `attrs` are loose. The editor writes `textAlign: null` on paragraphs and headings and
//    `nodeId: null` on code blocks; rejecting those would reject every real post and kill any
//    read-modify-write flow. Required attrs still guard, so a heading without `level` fails.

const looseAttrs = z.looseObject({});

const markSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('strong')}).describe('Bold.'),
  z.strictObject({type: z.literal('em')}).describe('Italic.'),
  z.strictObject({type: z.literal('code')}).describe('Inline code, for a short literal inside a sentence.'),
  z.strictObject({type: z.literal('strikethrough')}).describe('Struck through.'),
  z.strictObject({
    type: z.literal('link'),
    attrs: z.looseObject({href: z.string().describe('Absolute URL.')}),
  }).describe('A link. The visible words are the text node this mark is applied to.'),
]).describe('An inline mark applied to a text node. A mark is never a node in its own right.');

const textNode = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(markSchema).optional().describe('Omit when the text is plain. Marks may combine.'),
}).describe('A run of text. Split a sentence into several text nodes to mark only part of it.');

const hardBreakNode = z.strictObject({type: z.literal('hard_break')})
  .describe('A line break inside a paragraph. Prefer separate paragraphs.');

const inlineContent = z.array(z.discriminatedUnion('type', [textNode, hardBreakNode]));

const paragraphNode = z.strictObject({
  type: z.literal('paragraph'),
  attrs: looseAttrs.optional(),
  content: inlineContent.optional().describe('Omit for an empty paragraph.'),
});

const headingNode = z.strictObject({
  type: z.literal('heading'),
  attrs: z.looseObject({level: z.number().int().min(1).max(6)}),
  content: inlineContent,
});

export const postBodySchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(z.discriminatedUnion('type', [paragraphNode, headingNode])),
}).describe('The post body as a Substack ProseMirror document.');
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass, 0 fail.

- [ ] **Step 5: Prove the tests can fail**

Loosen `type` from a discriminated union to a plain union, which is the mistake this design rejected:

```bash
grep -c "discriminatedUnion('type', \[paragraphNode, headingNode\])" src/api/substack/document.js
```

Expected: `1`. Now mutate and re-run:

```bash
perl -0pi -e "s/z\.discriminatedUnion\('type', \[paragraphNode, headingNode\]\)/z.union([paragraphNode, headingNode])/" src/api/substack/document.js
grep -c "z.union(\[paragraphNode, headingNode\])" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the grep prints `1` (the mutation landed) and the test named "names the valid node types when the type is unrecognised" fails. Restore:

```bash
perl -0pi -e "s/z\.union\(\[paragraphNode, headingNode\]\)/z.discriminatedUnion('type', [paragraphNode, headingNode])/" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: green again.

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/document.js src/api/substack/document.spec.js
git commit -m "Add the post body document schema: marks, text, paragraphs, headings"
```

---

## Task 2: Lists and blockquotes

**Files:**
- Modify: `src/api/substack/document.js`
- Modify: `src/api/substack/document.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/api/substack/document.spec.js`:

```js
describe('postBodySchema — lists and quotes', () => {
  const item = (value) => ({type: 'list_item', content: [{type: 'paragraph', content: [text(value)]}]});

  test('accepts a bulleted list', () => {
    assert.equal(parse(doc({type: 'bullet_list', content: [item('one'), item('two')]})).success, true);
  });

  test('accepts a numbered list', () => {
    assert.equal(parse(doc({type: 'ordered_list', content: [item('one')]})).success, true);
  });

  test('accepts the start attr the editor writes', () => {
    const list = {type: 'ordered_list', attrs: {start: 3, type: null, order: 1}, content: [item('three')]};
    const result = parse(doc(list));

    assert.equal(result.success, true);
    assert.equal(result.data.content[0].attrs.start, 3);
  });

  test('accepts a list nested inside a list item', () => {
    const nested = {
      type: 'list_item',
      content: [
        {type: 'paragraph', content: [text('outer')]},
        {type: 'bullet_list', content: [item('inner')]},
      ],
    };

    assert.equal(parse(doc({type: 'bullet_list', content: [nested]})).success, true);
  });

  test('rejects a list item outside a list', () => {
    assert.equal(parse(doc(item('stray'))).success, false);
  });

  test('rejects bare text directly inside a list item', () => {
    assert.equal(parse(doc({type: 'bullet_list', content: [{type: 'list_item', content: [text('x')]}]})).success, false);
  });

  test('accepts a blockquote of paragraphs', () => {
    const quote = {type: 'blockquote', content: [{type: 'paragraph', content: [text('quoted')]}]};

    assert.equal(parse(doc(quote)).success, true);
  });

  test('accepts a blockquote containing a list', () => {
    const quote = {type: 'blockquote', content: [{type: 'bullet_list', content: [item('one')]}]};

    assert.equal(parse(doc(quote)).success, true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -cE '^(not ok|✖)'
```

Expected: a non-zero count — every new test fails on the discriminator, which does not yet list `bullet_list`.

- [ ] **Step 3: Add the recursive nodes**

In `src/api/substack/document.js`, insert after `headingNode` and before `postBodySchema`. Note the
node-level `.describe()` on each: the description test from Task 1 walks every union in the converted
schema, nested ones included, so a node without one fails the suite and gets named.

```js
// Recursion through getters, which is how zod 4 expresses it. The unions here stay discriminated
// even though it is more awkward than a plain union: a plain one reports no usable message, and
// this was measured rather than assumed.
const listItemNode = z.strictObject({
  type: z.literal('list_item'),
  get content() {
    return z.array(z.discriminatedUnion('type', [paragraphNode, bulletListNode, orderedListNode]))
      .describe('A paragraph, plus a nested list for sub-items.');
  },
}).describe('One item of a list. Its text goes in a paragraph, never directly in the item.');

const bulletListNode = z.strictObject({
  type: z.literal('bullet_list'),
  attrs: looseAttrs.optional(),
  get content() { return z.array(listItemNode); },
}).describe('A bulleted list.');

const orderedListNode = z.strictObject({
  type: z.literal('ordered_list'),
  attrs: looseAttrs.extend({start: z.number().int().optional()}).optional()
    .describe('Omit unless the list starts somewhere other than 1.'),
  get content() { return z.array(listItemNode); },
}).describe('A numbered list.');

const blockquoteNode = z.strictObject({
  type: z.literal('blockquote'),
  get content() { return z.array(z.discriminatedUnion('type', [paragraphNode, bulletListNode, orderedListNode])); },
}).describe('A quotation. Holds paragraphs and lists, not bare text.');
```

Then extend the document's union:

```js
export const postBodySchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(z.discriminatedUnion('type', [
    paragraphNode, headingNode, bulletListNode, orderedListNode, blockquoteNode,
  ])),
}).describe('The post body as a Substack ProseMirror document.');
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass.

- [ ] **Step 5: Prove the nesting test can fail**

Make `list_item` accept only paragraphs, so the nested case breaks. Reversible in place — do **not** use
`git checkout` here, it would discard this task's uncommitted work:

```bash
grep -c "paragraphNode, bulletListNode, orderedListNode" src/api/substack/document.js
perl -pi -e "s/\[paragraphNode, bulletListNode, orderedListNode\]\)\)/[paragraphNode])) \/*MUT*\//" src/api/substack/document.js
grep -c "MUT" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the `MUT` grep prints a non-zero count (the mutation landed) and both "accepts a list
nested inside a list item" and "accepts a blockquote containing a list" fail. Restore:

```bash
perl -pi -e "s/\[paragraphNode\]\)\) \/\*MUT\*\//[paragraphNode, bulletListNode, orderedListNode]))/" src/api/substack/document.js
grep -c "MUT" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `0` markers left and a green run.

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/document.js src/api/substack/document.spec.js
git commit -m "Model lists and blockquotes, recursively"
```

---

## Task 3: Code blocks, rule, and the paywall cap

**Files:**
- Modify: `src/api/substack/document.js`
- Modify: `src/api/substack/document.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/api/substack/document.spec.js`:

```js
describe('postBodySchema — code, rules and the paywall', () => {
  const code = (attrs) => ({type: 'highlighted_code_block', ...(attrs ? {attrs} : {}), content: [text('const a = 1;')]});

  test('accepts a code block with a language', () => {
    assert.equal(parse(doc(code({language: 'javascript'}))).success, true);
  });

  test('accepts a code block with no language, which auto-detects', () => {
    assert.equal(parse(doc(code())).success, true);
  });

  test('preserves the nodeId the editor writes', () => {
    const result = parse(doc(code({language: 'python', nodeId: null})));

    assert.deepEqual(result.data.content[0].attrs, {language: 'python', nodeId: null});
  });

  // Both node names are in live use: older posts carry code_block, the current editor writes
  // highlighted_code_block. Rejecting the legacy one would reject those posts.
  test('accepts the legacy code_block', () => {
    assert.equal(parse(doc({type: 'code_block', content: [text('legacy')]})).success, true);
  });

  test('accepts a horizontal rule', () => {
    assert.equal(parse(doc({type: 'horizontal_rule'})).success, true);
  });

  test('accepts a single paywall', () => {
    assert.equal(parse(doc({type: 'paragraph', content: [text('free')]}, {type: 'paywall'})).success, true);
  });

  // Measured 2026-08-07: two paywalls are accepted by the API with a 200 and rendered by the editor
  // as two "Paid content below this line" markers, so which one cuts the post is undefined. Neither
  // the API nor the editor guards this; this refinement is the only check that exists.
  test('rejects a second paywall', () => {
    const result = parse(doc({type: 'paywall'}, {type: 'paragraph'}, {type: 'paywall'}));

    assert.equal(result.success, false);
    assert.match(result.error.issues.map(i => i.message).join(' '), /at most one paywall/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -cE '^(not ok|✖)'
```

Expected: non-zero.

- [ ] **Step 3: Add the nodes and the refinement**

Insert after `blockquoteNode`:

```js
// `highlighted_code_block`, not `codeBlock`: read off the live editor. `python-substack` declares
// the latter, and a node by that name is not rendered.
const codeBlockNode = z.strictObject({
  type: z.literal('highlighted_code_block'),
  attrs: z.looseObject({
    language: z.string().optional().describe(
      'Lowercase highlight.js name — javascript, typescript, python, bash, json, sql, go, rust, ' +
      'yaml, css, html and similar. Omit to let Substack auto-detect. An unrecognised value is ' +
      'accepted and then silently rendered as plain text, so omitting beats guessing.'
    ),
  }).optional(),
  content: inlineContent.describe('One text node holding the whole snippet, newlines included.'),
}).describe('A syntax-highlighted code block.');

const legacyCodeBlockNode = z.strictObject({
  type: z.literal('code_block'),
  attrs: looseAttrs.optional(),
  content: inlineContent,
}).describe('The older code block, still present in existing posts. Use highlighted_code_block for new content.');

const horizontalRuleNode = z.strictObject({type: z.literal('horizontal_rule')})
  .describe('A horizontal divider.');

const paywallNode = z.strictObject({type: z.literal('paywall')})
  .describe('Everything after this node is for paying subscribers only. At most one per document.');
```

Extend the union and wrap the document in the refinement:

```js
export const postBodySchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(z.discriminatedUnion('type', [
    paragraphNode, headingNode, bulletListNode, orderedListNode, blockquoteNode,
    codeBlockNode, legacyCodeBlockNode, horizontalRuleNode, paywallNode,
  ])),
})
  .describe('The post body as a Substack ProseMirror document.')
  // A refinement does not survive into the published JSON Schema — verified — which is why the rule
  // is also written into paywallNode's description. Without that a model would meet it by failing.
  .refine(
    (document) => document.content.filter((node) => node.type === 'paywall').length <= 1,
    {message: 'A document may contain at most one paywall node.', path: ['content']}
  );
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass.

- [ ] **Step 5: Prove the paywall cap can fail**

```bash
grep -c "length <= 1" src/api/substack/document.js
perl -pi -e "s/length <= 1/length <= 2/" src/api/substack/document.js
grep -c "length <= 2" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the second grep prints `1` and "rejects a second paywall" fails. Restore:

```bash
perl -pi -e "s/length <= 2/length <= 1/" src/api/substack/document.js
```

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/document.js src/api/substack/document.spec.js
git commit -m "Model code blocks and rules, and cap the paywall at one"
```

---

## Task 4: Images, buttons, and the three opaque nodes

**Files:**
- Modify: `src/api/substack/document.js`
- Modify: `src/api/substack/document.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/api/substack/document.spec.js`:

```js
describe('postBodySchema — images, buttons and opaque nodes', () => {
  const image = {type: 'image2', attrs: {src: 'https://substackcdn.com/image/fetch/x.png', alt: 'A board'}};

  test('accepts an image inside a captionedImage', () => {
    assert.equal(parse(doc({type: 'captionedImage', content: [image]})).success, true);
  });

  test('accepts a caption after the image', () => {
    const caption = {type: 'caption', content: [text('One task per alert.')]};

    assert.equal(parse(doc({type: 'captionedImage', content: [image, caption]})).success, true);
  });

  test('rejects an image2 outside a captionedImage', () => {
    assert.equal(parse(doc(image)).success, false);
  });

  test('rejects an image with no src', () => {
    const bare = {type: 'image2', attrs: {alt: 'nothing'}};

    assert.match(parse(doc({type: 'captionedImage', content: [bare]})).error.issues.map(i => i.path.join('.')).join(' '), /attrs/);
  });

  test('preserves the many attrs the editor writes on an image', () => {
    const rich = {type: 'image2', attrs: {src: 'https://x.dev/a.png', width: 1456, height: 819, belowTheFold: false}};
    const result = parse(doc({type: 'captionedImage', content: [rich]}));

    assert.equal(result.data.content[0].content[0].attrs.width, 1456);
  });

  test('accepts a button', () => {
    const button = {type: 'button', attrs: {url: '%%checkout_url%%', text: 'Subscribe'}};

    assert.equal(parse(doc(button)).success, true);
  });

  test('rejects a button with no text', () => {
    assert.equal(parse(doc({type: 'button', attrs: {url: '%%checkout_url%%'}})).success, false);
  });

  // These three appear in the live archive — digestPostEmbed in 59 of 60 sampled posts — and their
  // internals were never read. Accepted whole so a read-modify-write round trip preserves them.
  for (const type of ['digestPostEmbed', 'substack_mentions', 'directMessage']) {
    test(`accepts ${type} and preserves what it carries`, () => {
      const node = {type, attrs: {id: 7}, content: [{type: 'anything', nested: true}]};
      const result = parse(doc(node));

      assert.equal(result.success, true);
      assert.deepEqual(result.data.content[0], node);
    });
  }

  // In 33 of 40 sampled posts on the second publication. Its absence would have blocked the round
  // trip on most of that archive — which is what a survey of only one publication had missed.
  test('accepts a youtube embed', () => {
    assert.equal(parse(doc({type: 'youtube2', attrs: {videoId: '0chZFIZLR_0'}})).success, true);
  });

  test('rejects a youtube embed with no videoId', () => {
    assert.equal(parse(doc({type: 'youtube2', attrs: {}})).success, false);
  });

  test('rejects a node type outside the enumeration, naming the alternatives', () => {
    const message = issues(doc({type: 'subscribeWidget', attrs: {}})).join(' ');

    assert.match(message, /Invalid discriminator value/);
    assert.match(message, /'captionedImage'/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -cE '^(not ok|✖)'
```

Expected: non-zero.

- [ ] **Step 3: Add the nodes**

Insert after `paywallNode`:

```js
const captionedImageNode = z.strictObject({
  type: z.literal('captionedImage'),
  content: z.array(z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('image2'),
      attrs: z.looseObject({
        src: z.string().describe('Image URL. It must already be hosted by Substack — an external url is stored but does not render.'),
        alt: z.string().nullable().optional(),
      }),
    }),
    z.strictObject({type: z.literal('caption'), content: inlineContent.optional()}),
  ])),
}).describe('An image, optionally followed by a caption node.');

const buttonNode = z.strictObject({
  type: z.literal('button'),
  attrs: z.looseObject({
    url: z.string().describe('Target, or a Substack placeholder: %%checkout_url%% to subscribe, %%share_url%% to share.'),
    text: z.string().describe('The button label.'),
  }),
}).describe('A call-to-action button.');

// Verified 2026-08-07 on the quickviewai publication, where it appears in 33 of 40 sampled posts:
// exactly `{videoId}` and no content, identical in every occurrence. `SubstackPost.youtubeVideo()`
// already builds this shape, so on this one node the existing builder was right.
const youtubeNode = z.strictObject({
  type: z.literal('youtube2'),
  attrs: z.looseObject({videoId: z.string().describe('The YouTube video id, not the watch URL.')}),
}).describe('An embedded YouTube video.');

// A node whose internals were never read. `looseObject` keeps everything it carries — including its
// content — so a round trip preserves it exactly, while claiming no knowledge we do not have.
const opaqueNode = (type, description) =>
  z.looseObject({type: z.literal(type)}).describe(description);

// Present in the live archive, internals never read.
const digestPostEmbedNode = opaqueNode('digestPostEmbed', 'An embedded post card. Substack inserts this itself; pass it back unchanged.');
const substackMentionsNode = opaqueNode('substack_mentions', 'A mention of another publication or user.');
const directMessageNode = opaqueNode('directMessage', 'A direct-message block.');
```

Extend the union to its final membership:

```js
    paragraphNode, headingNode, bulletListNode, orderedListNode, blockquoteNode,
    codeBlockNode, legacyCodeBlockNode, horizontalRuleNode, paywallNode,
    captionedImageNode, buttonNode, youtubeNode,
    digestPostEmbedNode, substackMentionsNode, directMessageNode,
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass.

- [ ] **Step 5: Prove the opaque-node test can fail**

Make `digestPostEmbed` strict, so it stops preserving what it carries:

```bash
grep -c "opaqueNode('digestPostEmbed'" src/api/substack/document.js
perl -0pi -e "s/z\.looseObject\(\{type: z\.literal\(type\)\}\)\.describe\(description\)/z.strictObject({type: z.literal(type)}).describe(description)/" src/api/substack/document.js
grep -c "z.strictObject({type: z.literal(type)})" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -4
```

Expected: the second grep prints `1` and the three "preserves what it carries" tests fail. Restore:

```bash
perl -0pi -e "s/z\.strictObject\(\{type: z\.literal\(type\)\}\)\.describe\(description\)/z.looseObject({type: z.literal(type)}).describe(description)/" src/api/substack/document.js
```

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/document.js src/api/substack/document.spec.js
git commit -m "Model images, buttons and the three opaque archive nodes"
```

---

## Task 5: The node tally, and fixtures shaped like real documents

**Files:**
- Modify: `src/api/substack/document.js`
- Modify: `src/api/substack/document.spec.js`

Validation cannot report a paywall that was never sent — the head-to-head run produced a document that passes this schema with its paywall missing. The tally is what closes that gap: the caller sees what actually landed.

- [ ] **Step 1: Write the failing test**

Append to `src/api/substack/document.spec.js`:

```js
describe('summarizeNodes', () => {
  test('counts the node types in a flat document', () => {
    const document = {type: 'doc', content: [
      {type: 'paragraph', content: [text('a')]},
      {type: 'paragraph', content: [text('b')]},
      {type: 'horizontal_rule'},
    ]};

    assert.deepEqual(summarizeNodes(document), {paragraph: 2, horizontal_rule: 1});
  });

  test('counts nodes nested inside lists and quotes', () => {
    const document = {type: 'doc', content: [{
      type: 'bullet_list',
      content: [{type: 'list_item', content: [{type: 'paragraph', content: [text('x')]}]}],
    }]};

    assert.deepEqual(summarizeNodes(document), {bullet_list: 1, list_item: 1, paragraph: 1});
  });

  // `text` is excluded on purpose: a tally dominated by hundreds of text runs buries the one number
  // a caller is looking for, which is whether the paywall and the button are there.
  test('does not count text or the doc itself', () => {
    const summary = summarizeNodes({type: 'doc', content: [{type: 'paragraph', content: [text('a'), text('b')]}]});

    assert.deepEqual(summary, {paragraph: 1});
  });

  test('counts a paywall so a caller can confirm it landed', () => {
    const summary = summarizeNodes({type: 'doc', content: [{type: 'paywall'}]});

    assert.deepEqual(summary, {paywall: 1});
  });

  test('returns an empty object for an empty document', () => {
    assert.deepEqual(summarizeNodes({type: 'doc', content: []}), {});
  });
});
```

Add `summarizeNodes` to the import at the top of the spec:

```js
import {postBodySchema, summarizeNodes} from './document.js';
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: failures — `summarizeNodes is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/api/substack/document.js`:

```js
/**
 * Counts the nodes in a document by type, so a caller can confirm that what it asked for landed.
 *
 * Validation cannot do this job: a document with no paywall is as valid as one with a paywall, so
 * legality has no opinion about an omission. `text` and `doc` are left out — a tally dominated by
 * text runs buries the numbers that are actually being looked for.
 */
export const summarizeNodes = (document) => {
  const counts = {};

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (typeof node.type === 'string' && node.type !== 'text' && node.type !== 'doc') {
      counts[node.type] = (counts[node.type] ?? 0) + 1;
    }

    if (Array.isArray(node.content)) node.content.forEach(walk);
  };

  walk(document);
  return counts;
};
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass.

- [ ] **Step 5: Prove it can fail**

```bash
grep -c "node.type !== 'text'" src/api/substack/document.js
perl -pi -e "s/node\.type !== 'text' && //" src/api/substack/document.js
grep -c "node.type !== 'text'" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the second grep prints `0` (the mutation landed) and "does not count text or the doc
itself" fails. Restore in place — a `git checkout` would discard this task's uncommitted work:

```bash
perl -pi -e "s/node\.type !== 'doc'/node.type !== 'text' && node.type !== 'doc'/" src/api/substack/document.js
grep -c "node.type !== 'text'" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `1` and a green run.

- [ ] **Step 6: Add the two fixtures the spec calls for**

Unit tests built from the schema outwards prove the schema agrees with itself. These two prove it
agrees with reality. Append to `src/api/substack/document.spec.js`:

```js
// Shaped like a real published post rather than like something a writer would compose: every
// paragraph and heading carries attrs: {textAlign: null}, and the three nodes below appear in the
// live archive — digestPostEmbed in 59 of 60 sampled posts. If this stops validating, the round trip
// this contract exists to allow is broken, and no schema-first test would notice.
const REAL_POST_SHAPE = {
  type: 'doc',
  content: [
    {type: 'digestPostEmbed', attrs: {id: 210189950, publication_id: 2150088}},
    {type: 'heading', attrs: {textAlign: null, level: 2}, content: [{type: 'text', text: 'A section'}]},
    {type: 'paragraph', attrs: {textAlign: null}, content: [
      {type: 'text', text: 'Prose with '},
      {type: 'text', marks: [{type: 'strong'}], text: 'weight'},
      {type: 'text', text: ' and a '},
      {type: 'text', marks: [{type: 'link', attrs: {href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow', class: null}}], text: 'link'},
      {type: 'text', text: '.'},
    ]},
    {type: 'captionedImage', content: [
      {type: 'image2', attrs: {src: 'https://substackcdn.com/image/fetch/x.png', srcNoWatermark: null, fullscreen: false, imageSize: 'normal', height: 819, width: 1456, resizeWidth: 728, bytes: null, alt: null, title: null, type: null, href: null, belowTheFold: false, topImage: false, internalRedirect: null, isProcessing: false, align: null, offset: false}},
      {type: 'caption', content: [{type: 'text', text: 'A caption'}]},
    ]},
    {type: 'button', attrs: {url: '%%share_url%%', text: 'Share', action: null, class: 'button-wrapper'}},
    {type: 'horizontal_rule'},
    {type: 'code_block', content: [{type: 'text', text: 'legacy snippet'}]},
    {type: 'substack_mentions', attrs: {publicationId: 2073698}},
  ],
};

// The structural shapes a model actually produced when handed the published schema, kept so a later
// tightening of the schema cannot quietly start rejecting documents that were known to work.
const MODEL_AUTHORED_SHAPE = {
  type: 'doc',
  content: [
    {type: 'ordered_list', attrs: {start: 3}, content: [
      {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'three'}]}]},
    ]},
    {type: 'bullet_list', content: [
      {type: 'list_item', content: [
        {type: 'paragraph', content: [{type: 'text', text: 'context'}]},
        {type: 'bullet_list', content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'nested'}]}]},
        ]},
      ]},
      {type: 'list_item', content: [{type: 'paragraph', content: [
        {type: 'text', marks: [{type: 'link', attrs: {href: 'https://example.com/fixed'}}], text: 'a link in a list item'},
      ]}]},
    ]},
    {type: 'blockquote', content: [
      {type: 'bullet_list', content: [
        {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'quoted item'}]}]},
      ]},
    ]},
    {type: 'highlighted_code_block', attrs: {language: 'bash'}, content: [{type: 'text', text: 'set -euo pipefail'}]},
  ],
};

describe('postBodySchema — real documents', () => {
  test('accepts a document shaped like a real published post', () => {
    const result = parse(REAL_POST_SHAPE);

    assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error?.issues));
  });

  test('preserves the opaque archive nodes exactly', () => {
    const result = parse(REAL_POST_SHAPE);

    assert.deepEqual(result.data.content[0], REAL_POST_SHAPE.content[0]);
    assert.deepEqual(result.data.content.at(-1), REAL_POST_SHAPE.content.at(-1));
  });

  test('tallies a real-shaped post without drowning in text nodes', () => {
    assert.deepEqual(summarizeNodes(REAL_POST_SHAPE), {
      digestPostEmbed: 1, heading: 1, paragraph: 1, captionedImage: 1, image2: 1,
      caption: 1, button: 1, horizontal_rule: 1, code_block: 1, substack_mentions: 1,
    });
  });

  test('accepts the structures a model produced from the published schema', () => {
    const result = parse(MODEL_AUTHORED_SHAPE);

    assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error?.issues));
  });
});
```

- [ ] **Step 7: Run them and confirm they pass**

```bash
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: all pass. If the real-post fixture fails, the enumeration in Task 4 is incomplete — read the
reported path, do not loosen the schema to make it go away.

- [ ] **Step 8: Prove the real-post fixture is load-bearing**

Drop `digestPostEmbed` from the union and confirm the fixture goes red — this is the node that makes
read-modify-write possible at all:

```bash
grep -c "digestPostEmbedNode," src/api/substack/document.js
perl -pi -e "s/    digestPostEmbedNode, substackMentionsNode, directMessageNode,/    substackMentionsNode, directMessageNode, \/*MUT*\//" src/api/substack/document.js
grep -c "MUT" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -4
```

Expected: the `MUT` grep is non-zero and the real-post fixture tests fail. Restore:

```bash
perl -pi -e "s/    substackMentionsNode, directMessageNode, \/\*MUT\*\//    digestPostEmbedNode, substackMentionsNode, directMessageNode,/" src/api/substack/document.js
grep -c "MUT" src/api/substack/document.js
node --test src/api/substack/document.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `0` markers left and a green run.

- [ ] **Step 9: Commit**

```bash
git add src/api/substack/document.js src/api/substack/document.spec.js
git commit -m "Add a node tally and fixtures shaped like real documents"
```

---

## Task 6: The set_post_body tool

**Files:**
- Create: `src/tools/set_post_body.js`
- Create: `src/tools/set_post_body.spec.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write the failing test**

Create `src/tools/set_post_body.spec.js`:

```js
import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {setPostBodyHandler, setPostBodySchema} from './set_post_body.js';
import {createMswServer, DRAFT_RESPONSE} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';
import {captureLogs} from '../../test/helpers/capture-logs.js';

const msw = createMswServer();
let restoreEnv;

before(() => {
  restoreEnv = setTestEnv();
  msw.start();
});
afterEach(() => msw.reset());
after(() => {
  msw.stop();
  restoreEnv();
});

const DOC = {type: 'doc', content: [
  {type: 'paragraph', content: [{type: 'text', text: 'Free intro.'}]},
  {type: 'paywall'},
  {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Paid'}]},
]};
const VALID_ARGS = {draft_id: 210218832, body: DOC};

describe('setPostBodySchema', () => {
  test('requires a draft_id and a body', () => {
    assert.throws(() => setPostBodySchema.parse({}), z.ZodError);
    assert.throws(() => setPostBodySchema.parse({draft_id: 1}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    try {
      setPostBodySchema.parse({...VALID_ARGS, draft_body: DOC});
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.issues.map(i => i.message).join(' '), /Unrecognized key/);
      assert.match(error.issues.map(i => i.message).join(' '), /draft_body/);
    }
  });

  test('rejects a body that is a JSON string rather than an object', () => {
    assert.throws(() => setPostBodySchema.parse({draft_id: 1, body: JSON.stringify(DOC)}), z.ZodError);
  });
});

describe('setPostBodyHandler', () => {
  test('sends draft_body as a serialized document to the draft', async () => {
    await setPostBodyHandler(VALID_ARGS);

    const request = msw.requests.at(-1);
    assert.equal(request.method, 'PUT');
    assert.match(request.url, /\/drafts\/210218832$/);
    assert.deepEqual(JSON.parse(request.body.draft_body), DOC);
  });

  // JSON.stringify, not the object: draft_body goes on the wire as a string. SubstackPost.getDraft
  // has the same rule, and passing an already-serialized string there double-encoded it once (#4).
  test('sends draft_body as a string, not as a nested object', async () => {
    await setPostBodyHandler(VALID_ARGS);

    assert.equal(typeof msw.requests.at(-1).body.draft_body, 'string');
  });

  test('sends nothing but draft_body, so no other draft field is touched', async () => {
    await setPostBodyHandler(VALID_ARGS);

    assert.deepEqual(Object.keys(msw.requests.at(-1).body), ['draft_body']);
  });

  test('returns the tally of what it stored', async () => {
    const result = await setPostBodyHandler(VALID_ARGS);

    assert.deepEqual(result, {draft_id: 210218832, nodes: {paragraph: 1, paywall: 1, heading: 1}});
  });

  test('rejects a second paywall without issuing a request', async () => {
    const body = {type: 'doc', content: [{type: 'paywall'}, {type: 'paywall'}]};

    await assert.rejects(() => setPostBodyHandler({draft_id: 1, body}), z.ZodError);
    assert.equal(msw.requests.length, 0, 'no request should have been made');
  });

  test('propagates a failing response', async () => {
    msw.server.use(msw.draftUpdateHandler(() => HttpResponse.json({}, {status: 404})));

    await assert.rejects(() => setPostBodyHandler(VALID_ARGS), /404/);
  });

  test('logs its intent before the request and the tally after', async () => {
    const logs = await captureLogs(() => setPostBodyHandler(VALID_ARGS));
    const events = logs.map(line => line.msg);

    assert.ok(events.includes('set_post_body.writing'), `expected set_post_body.writing in ${events.join(', ')}`);
    assert.ok(events.includes('set_post_body.done'));
    const done = logs.find(line => line.msg === 'set_post_body.done');
    assert.deepEqual(done.nodes, {paragraph: 1, paywall: 1, heading: 1});
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/tools/set_post_body.spec.js 2>&1 | tail -20
```

Expected: `Cannot find module './set_post_body.js'`.

- [ ] **Step 3: Write the tool**

Create `src/tools/set_post_body.js`:

```js
import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {postBodySchema, summarizeNodes} from "../api/substack/document.js";
import {logger} from "../logger.js";

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call. A model reaching for the
// wire name `draft_body` is told that key is unrecognised instead of having it silently dropped and
// being told `body` is missing.
//
// This is the one tool that publishes the document schema. Keeping it here rather than on
// create_draft_post and update_draft both is deliberate: the schema is ~16 KB, and paying it twice
// would grow tools/list by over 90% for every session, including those that never write a post.
export const setPostBodySchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to write, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  body: postBodySchema,
});

export const setPostBodyHandler = async (args) => {
  logger.debug('set_post_body.start', {args});

  let validatedArgs;

  try {
    validatedArgs = setPostBodySchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('set_post_body.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, body} = validatedArgs;
  const nodes = summarizeNodes(body);

  // Logged before the request, not only after: this replaces a body outright, and the previous one
  // is not recoverable from anywhere in this server.
  logger.info('set_post_body.writing', {draft_id, nodes});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // JSON.stringify, because draft_body goes on the wire as a string. Only this key is sent: PUT is
  // genuinely partial, so anything absent is left alone rather than cleared.
  await substack_api.updateDraft(draft_id, {draft_body: JSON.stringify(body)});

  logger.info('set_post_body.done', {draft_id, nodes});

  // The tally, not 'OK'. Validation cannot report a paywall that was never sent — a document
  // without one is as valid as a document with one — so the only way a caller can confirm that what
  // it asked for landed is to be told what landed. The log goes to stderr, where a model cannot
  // read it, which makes the result the only channel back.
  return {draft_id, nodes};
};
```

- [ ] **Step 4: Register it**

In `src/server.js`, add the import beside the others:

```js
import {setPostBodySchema, setPostBodyHandler} from "./tools/set_post_body.js";
```

And add the registry entry immediately after the `create_draft_post` entry:

```js
  set_post_body: {
    description:
      "replace the body of a draft with a Substack document. This is the only way to write " +
      "structured content — headings, lists, links, code blocks, images, buttons and a paywall. " +
      "Create the draft first with create_draft_post, then call this with its id. The result " +
      "reports how many nodes of each type were stored, so a caller can confirm that what it " +
      "asked for is there.",
    schema: setPostBodySchema,
    handler: setPostBodyHandler,
  },
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
node --test src/tools/set_post_body.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: both green, and the full-suite count risen from 590.

- [ ] **Step 6: Prove the double-encoding test can fail**

This is the bug the repository has already shipped once (#4), so its guard has to be real:

```bash
grep -c "JSON.stringify(body)" src/tools/set_post_body.js
perl -pi -e "s/\{draft_body: JSON\.stringify\(body\)\}/{draft_body: body}/" src/tools/set_post_body.js
grep -c "{draft_body: body}" src/tools/set_post_body.js
node --test src/tools/set_post_body.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the second grep prints `1` and "sends draft_body as a string, not as a nested object" fails. Restore:

```bash
perl -pi -e "s/\{draft_body: body\}/{draft_body: JSON.stringify(body)}/" src/tools/set_post_body.js
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/set_post_body.js src/tools/set_post_body.spec.js src/server.js
git commit -m "Add set_post_body, the one tool that publishes the document schema"
```

---

## Task 7: create_draft_post shares the validator

**Files:**
- Modify: `src/tools/create_draft_post.js:29-57`
- Modify: `src/tools/create_draft_post.spec.js`

Today the JSON branch forwards anything with `type: 'doc'` **unvalidated** — the only structured route into this server, and the one with no checks. It starts using the same schema. The schema is not published on this tool, so `tools/list` does not grow.

- [ ] **Step 1: Rewrite the characterization test**

In `src/tools/create_draft_post.spec.js`, find the test named `a ProseMirror document given as JSON is passed through untouched` and replace it with:

```js
  // Was a characterization test pinning unvalidated passthrough: anything carrying type: 'doc' went
  // to Substack as-is. It is validated now, so a wrong node name is an error instead of a draft with
  // its content silently mangled. Changed together with the source, as CLAUDE.md requires.
  test('a valid ProseMirror document given as JSON is passed through untouched', async () => {
    const documento = {
      type: 'doc',
      content: [
        {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Title'}]},
        {type: 'paragraph', content: [{type: 'text', text: 'Body'}]},
      ],
    };

    await createDraftPostHandler({...VALID_ARGS, body: JSON.stringify(documento)});

    assert.deepEqual(JSON.parse(msw.requests.at(-1).body.draft_body), documento);
  });

  test('an invalid document is rejected rather than forwarded', async () => {
    const broken = JSON.stringify({type: 'doc', content: [{type: 'codeBlock', content: []}]});

    await assert.rejects(() => createDraftPostHandler({...VALID_ARGS, body: broken}), z.ZodError);
    assert.equal(msw.requests.length, 0, 'no request should have been made');
  });

  test('the rejection names the valid node types', async () => {
    const broken = JSON.stringify({type: 'doc', content: [{type: 'codeBlock', content: []}]});
    const error = await createDraftPostHandler({...VALID_ARGS, body: broken}).catch(e => e);

    assert.match(error.issues.map(i => i.message).join(' '), /Invalid discriminator value/);
  });

  // JSON that parses but is not a document keeps its existing behaviour — treated as text — because
  // it never claimed to be one. Only a value carrying type: 'doc' is held to the schema.
  test('valid JSON that is not a document is still treated as text', async () => {
    await createDraftPostHandler({...VALID_ARGS, body: '{"a":1}'});

    const sent = JSON.parse(msw.requests.at(-1).body.draft_body);
    assert.deepEqual(sent.content[0].content[0].text, '{"a":1}');
  });
```

Make sure `z` is imported in that spec — it already is, for the schema tests.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/tools/create_draft_post.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: "an invalid document is rejected rather than forwarded" fails — today the request goes out.

- [ ] **Step 3: Wire in the validator**

In `src/tools/create_draft_post.js`, add the import:

```js
import {postBodySchema} from "../api/substack/document.js";
```

Replace the body of `parseBody` (lines 29-57) with:

```js
const parseBody = (body) => {
  try {
    const doc = JSON.parse(body);
    if (doc && doc.type === 'doc') {
      // Validated, not forwarded. This branch used to be the one structured route into the server
      // and the only one with no checks, so a wrong node name created a draft with its content
      // mangled and said nothing. The schema is shared with set_post_body but deliberately not
      // published here: validating costs nothing, publishing would cost ~16 KB on every session.
      const validated = postBodySchema.parse(doc);
      logger.debug('draft.body.parsed', {format: 'prosemirror', nodes: validated.content.length});
      return validated;
    }

    // Valid JSON that is not a document: it goes through as text, and a model that believed
    // it was sending a document would have no other way to find out.
    logger.debug('draft.body.json_is_not_a_document', {parsed: doc});
  } catch (error) {
    // A ZodError means it *was* a document and a bad one — that must reach the caller. Anything
    // else is JSON.parse failing, which just means the body is text.
    if (error instanceof z.ZodError) {
      logger.error('draft.body.invalid_document', {issues: error.issues});
      throw error;
    }
    // not JSON, treat as plain text
  }

  const doc = {
    type: 'doc',
    content: body
      .split(/\n+/)
      .filter(paragraph => paragraph.trim() !== '')
      .map(paragraph => ({
        type: 'paragraph',
        content: [{type: 'text', text: paragraph}],
      })),
  };

  logger.debug('draft.body.parsed', {format: 'text', nodes: doc.content.length, chars: body.length});
  return doc;
};
```

Note the `catch` now has to distinguish two failures that previously could not both happen. Getting this wrong turns a validation error into "treated as text", which would publish the broken document as literal JSON — the test in Step 1 is what catches that.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test src/tools/create_draft_post.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: both green.

- [ ] **Step 5: Prove the ZodError re-throw is load-bearing**

```bash
grep -c "error instanceof z.ZodError" src/tools/create_draft_post.js
perl -0pi -e "s/if \(error instanceof z\.ZodError\) \{\n      logger\.error\('draft\.body\.invalid_document', \{issues: error\.issues\}\);\n      throw error;\n    \}\n    //" src/tools/create_draft_post.js
grep -c "error instanceof z.ZodError" src/tools/create_draft_post.js
node --test src/tools/create_draft_post.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the second grep prints `0` and "an invalid document is rejected rather than forwarded"
fails — the broken document is silently treated as text instead.

Restore by re-inserting the guard (a `git checkout` would discard this task's uncommitted work):

```bash
perl -0pi -e "s/    \/\/ not JSON, treat as plain text/    if (error instanceof z.ZodError) {\n      logger.error('draft.body.invalid_document', {issues: error.issues});\n      throw error;\n    }\n    \/\/ not JSON, treat as plain text/" src/tools/create_draft_post.js
grep -c "error instanceof z.ZodError" src/tools/create_draft_post.js
node --test src/tools/create_draft_post.spec.js 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `1` and a green run.

- [ ] **Step 6: Commit**

```bash
git add src/tools/create_draft_post.js src/tools/create_draft_post.spec.js
git commit -m "Validate create_draft_post's JSON branch instead of forwarding it"
```

---

## Task 8: Protocol-level assertions, and both runtimes

**Files:**
- Modify: `src/server.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/server.spec.js`, inside the outermost `describe` that already covers the registry (match the surrounding style — read the file first):

```js
describe('set_post_body over the protocol', () => {
  test('is registered and published with a body parameter', async () => {
    const {client, close} = await connect();

    try {
      const {tools} = await client.listTools();
      const tool = tools.find(t => t.name === 'set_post_body');

      assert.ok(tool, 'set_post_body should be registered');
      assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['body', 'draft_id']);
      assert.equal(tool.inputSchema.additionalProperties, false);
    } finally {
      await close();
    }
  });

  // The published schema is what teaches a model the vocabulary. If the node names stop appearing in
  // it, the tool still works and every caller has to guess — which no other test would notice.
  test('publishes the node vocabulary a caller has to know', async () => {
    const {client, close} = await connect();

    try {
      const {tools} = await client.listTools();
      const published = JSON.stringify(tools.find(t => t.name === 'set_post_body').inputSchema);

      for (const type of ['paragraph', 'heading', 'bullet_list', 'highlighted_code_block', 'captionedImage', 'button', 'paywall']) {
        assert.match(published, new RegExp(`"${type}"`), `${type} should appear in the published schema`);
      }
    } finally {
      await close();
    }
  });

  // The recursion has to survive conversion, and draft-7 puts the shared shapes under `definitions`.
  // A $ref pointing at a definition that is not there would publish a schema no client can resolve.
  //
  // Asserting refs *exist* first is the point: the Task 1 reviewer found that with no recursion the
  // schema contains zero $refs, so a loop over discovered refs passes while checking nothing. The
  // recursive list and blockquote nodes are what put them there.
  test('publishes a self-contained schema, definitions included', async () => {
    const {client, close} = await connect();

    try {
      const {tools} = await client.listTools();
      const schema = tools.find(t => t.name === 'set_post_body').inputSchema;
      const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g)].map(m => m[1]);

      assert.ok(refs.length > 0, 'the recursive nodes should produce at least one $ref');

      for (const ref of refs) {
        assert.ok(schema.definitions?.[ref], `definitions.${ref} should exist`);
      }
    } finally {
      await close();
    }
  });

  test('reports a validation error as a result rather than rejecting', async () => {
    const {client, close} = await connect();

    try {
      // McpServer turns anything a tool throws into a successful CallToolResult with isError set,
      // so callTool does not reject. Asserting on a rejection here would check nothing.
      const result = await client.callTool({
        name: 'set_post_body',
        arguments: {draft_id: 1, body: {type: 'doc', content: [{type: 'codeBlock'}]}},
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /codeBlock|discriminator|Invalid/);
    } finally {
      await close();
    }
  });
});
```

`connect()` is the harness this spec already uses — check its exact name in `src/server.spec.js` and in `test/helpers/mcp-harness.js`, and use whatever the file already does rather than introducing a second pattern.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test src/server.spec.js 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: green if Task 6 landed — in which case **make it fail on purpose** to prove it asserts something. Comment out the `set_post_body` entry in the `tools` registry, re-run, confirm all four tests fail, restore.

- [ ] **Step 3: Run the whole suite on both runtimes**

The floor is exercised on every push by CI, and it is where runtime differences bite:

```bash
source ~/.nvm/nvm.sh && nvm exec --silent 22 npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
source ~/.nvm/nvm.sh && nvm use && npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: 0 failures on both. Note the output shape differs between them — TAP on 22, spec reporter on 24.

- [ ] **Step 4: Check what the schema costs**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SUBSTACK_PUBLICATION_URL=https://test.substack.com SUBSTACK_SESSION_TOKEN=tok SUBSTACK_USER_ID=1 \
    timeout 5 node src/index.js 2>/dev/null | sed -n '2p' | wc -c
```

Expected: roughly 50,000–52,000 bytes, up from 34,721. If it is materially larger, something is being published twice — check that `create_draft_post` did not gain the document schema.

- [ ] **Step 5: Commit**

```bash
git add src/server.spec.js
git commit -m "Assert set_post_body publishes a resolvable schema with the node vocabulary"
```

---

## Task 9: Verify against the live API, then document it

**Files:**
- Modify: `CLAUDE.md`

Nothing in this repository ships on inference. The schema was read off a live draft; the code that reproduces it has to be checked the same way, because a node name can be right in the spec and wrong in the source.

- [ ] **Step 1: Write a document using every modelled node into a scratch draft**

Create a throwaway draft with `create_draft_post`, note its `draft_id`, then call `set_post_body` with
exactly this document. Replace `<SUBSTACK_HOSTED_IMAGE_URL>` with a `src` from an image already on the
publication — an external URL is stored but does not render, so an invented one proves nothing:

```json
{"type": "doc", "content": [
  {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Every node"}]},
  {"type": "paragraph", "content": [
    {"type": "text", "text": "Plain, "},
    {"type": "text", "marks": [{"type": "strong"}], "text": "bold"},
    {"type": "text", "text": ", "},
    {"type": "text", "marks": [{"type": "em"}], "text": "italic"},
    {"type": "text", "text": ", "},
    {"type": "text", "marks": [{"type": "code"}], "text": "inline_code"},
    {"type": "text", "text": ", "},
    {"type": "text", "marks": [{"type": "strikethrough"}], "text": "struck"},
    {"type": "text", "text": ", and a "},
    {"type": "text", "marks": [{"type": "link", "attrs": {"href": "https://example.com/verify"}}], "text": "link"},
    {"type": "text", "text": "."}
  ]},
  {"type": "bullet_list", "content": [
    {"type": "list_item", "content": [
      {"type": "paragraph", "content": [{"type": "text", "text": "outer item"}]},
      {"type": "bullet_list", "content": [
        {"type": "list_item", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "nested item"}]}]}
      ]}
    ]}
  ]},
  {"type": "ordered_list", "attrs": {"start": 3}, "content": [
    {"type": "list_item", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "starts at three"}]}]}
  ]},
  {"type": "blockquote", "content": [
    {"type": "bullet_list", "content": [
      {"type": "list_item", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "quoted item"}]}]}
    ]}
  ]},
  {"type": "highlighted_code_block", "attrs": {"language": "javascript"},
   "content": [{"type": "text", "text": "const a = 1;\nconsole.log(a);"}]},
  {"type": "code_block", "content": [{"type": "text", "text": "legacy block"}]},
  {"type": "horizontal_rule"},
  {"type": "captionedImage", "content": [
    {"type": "image2", "attrs": {"src": "<SUBSTACK_HOSTED_IMAGE_URL>", "alt": "A verification image"}},
    {"type": "caption", "content": [{"type": "text", "text": "The caption"}]}
  ]},
  {"type": "button", "attrs": {"url": "%%checkout_url%%", "text": "Subscribe"}},
  {"type": "paywall"},
  {"type": "paragraph", "content": [{"type": "text", "text": "Behind the paywall."}]}
]}
```

The result's `nodes` tally must come back with `paywall: 1`, `button: 1`, `captionedImage: 1` and
`highlighted_code_block: 1`. If any of those is absent, stop — the tool dropped something.

- [ ] **Step 2: Confirm it renders**

Open `https://<publication>/publish/post/<draft_id>` and check every construct appears as intended.
Specifically: the nested bullet is indented under its parent, the numbered list starts at 3, the code
block's language selector reads **JavaScript** and not "Plain Text", the image shows with its caption
beneath, the button renders as a button rather than a link, and there is exactly one "Paid content
below this line" marker.

Two failures only this step catches: a node name that is right in the spec and wrong in the source,
and a `language` value that maps to nothing — which the API accepts with a 200 and the editor then
degrades to Plain Text without an error.

- [ ] **Step 3: Confirm the round trip on real posts**

`get_draft` on a **real published post**, `JSON.parse` its `draft_body`, and feed that straight back
through `set_post_body` on the scratch draft. It must validate untouched.

Do this for **at least five** posts from each of the two publications — `implementing` and
`quickviewai` — not five in total. The enumeration came from a survey, and surveying only the first
publication is exactly what missed `youtube2`, which turned out to be in 33 of 40 posts on the second. A post using a node the union does not list
fails loudly and names the alternatives — that is the designed behaviour, and the fix is to read that
node's shape off a live draft and add it, never to loosen the union.

`digestPostEmbed` alone is in 59 of 60 sampled posts, so if step 3 fails on the first post the three
opaque nodes are not doing their job.

- [ ] **Step 4: Clean up**

`delete_draft` on the scratch draft, then `get_draft` to confirm it 404s.

- [ ] **Step 5: Record it in CLAUDE.md**

Add to the Substack private-API section, after the draft-lifecycle paragraphs:

```markdown
**The post body has a contract, and `set_post_body` is where it lives.** `src/api/substack/document.js`
models the ProseMirror document in zod: a discriminated union over every node type observed in the live
archive, published as that tool's JSON Schema so a calling model reads the vocabulary from
`tools/list` rather than guessing. Four measured facts shape it:

- **The code block is `highlighted_code_block`.** `python-substack` declares `codeBlock`, which is not
  what the editor writes and not what renders. Both `code_block` (older posts) and
  `highlighted_code_block` (current editor) are in live use, so both are accepted.
- **`type` is strict and `attrs` are loose**, in opposite directions on purpose. The editor writes
  `textAlign: null` on every paragraph and heading and `nodeId: null` on code blocks, so strict attrs
  would reject every real post; a discriminated union on `type` is what produces
  `Invalid discriminator value. Expected 'paragraph' | 'heading' | …`, the only repair instruction an
  LLM gets. **A generic unknown-node branch was tried and rejected**: it keeps a malformed `heading`
  out but reports only the generic branch's error, so the caller never learns which field is wrong.
  Every observed node type is enumerated instead, including the three whose internals were never read
  — `digestPostEmbed`, `substack_mentions`, `directMessage` — as `looseObject`s that survive a round
  trip whole. `digestPostEmbed` alone is in 59 of 60 sampled posts, so this is what makes
  read-modify-write possible at all.
- **A document may carry one `paywall`, and we are the only ones enforcing it.** Two are accepted by
  `PUT /drafts/:id` with a 200 and rendered by the editor as two "Paid content below this line"
  markers, so which one cuts the post is undefined. The `.refine()` is the only check that exists —
  and since a refinement does **not** survive into the published JSON Schema, the rule is repeated in
  the node's own description or a model meets it only by failing.
- **The code-block `language` is a closed set that fails silently.** `auto` is the auto-detect
  sentinel, `plaintext` the plain-text value, and an unrecognised name renders as Plain Text with no
  error — the *sixth* silent-ignore in this API. Omitting the attr beats guessing.

`set_post_body` returns a **node tally**, not `'OK'`, because validation cannot report what was never
sent: a document with no paywall is exactly as valid as one with a paywall. This was measured — a
model asked for a paywall through a Markdown contract omitted it, produced valid Markdown, and the
document it rendered to passes this very schema. The tally is the only way a caller sees what landed.

`create_draft_post`'s JSON branch runs the same validator **without publishing the schema**: validating
costs nothing, publishing would cost ~16 KB, and it was the last route into this server that accepted
a body unchecked.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "Record the post body contract and the facts behind it"
```

---

## Task 10: Finish the branch

- [ ] **Step 1: Rename the branch, which still carries the abandoned approach's name**

```bash
git branch -m markdown-post-bodies post-body-contract
```

- [ ] **Step 2: Confirm the whole suite and the package contents**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
npm pack --dry-run 2>&1 | grep -c "spec.js"
```

Expected: 0 failures, and `0` spec files in the tarball — they are excluded by the `files` negation pattern, and a new directory can break that.

- [ ] **Step 3: Hand off**

Use `superpowers:finishing-a-development-branch` to decide how this integrates.

---

## Notes for whoever executes this

**The open item, carried from the spec:** the code-block language table. `auto` and `plaintext` are confirmed sentinels and the values are lowercase highlight.js names, but the full label-to-value mapping has to be lifted from the editor bundle (`grep` the loaded chunks for `plaintext` — the list is a `{value, label}` array near the "Auto-detect" string) rather than guessed. Until then the schema's description names the common ones and says omitting beats guessing, which is correct and honest; do not invent the rest.

**Do not add** `subscribeWidget`, `latex`, `footnote`, `poll`, `poetry`, `calloutBlock` or `pullquote` to the union in this plan. The first five exist as names in the editor's "More" menu but their shapes were never read; the last two come only from `python-substack`, the same file that was wrong about `codeBlock`, and do not appear in that menu at all. Each is a later addition after its shape is read off a live draft. A node outside the enumeration fails loudly and names the alternatives, which is the correct behaviour in the meantime.

`youtube2` **is** in the union, and how it got there is the cautionary tale: the first survey covered one publication and missed it, while it appears in 33 of 40 sampled posts on the second. If a third publication is ever added, survey it before trusting this enumeration.

**`SubstackPost.js` already has a builder** — `paywall()`, `shareButton()`, `customButton()`, `captionedImage()`, `subscribeWithCaption()` — that no tool reaches. This plan does not use it and does not delete it. Its index-based mutation (`content[length - 1]`) cannot express nesting, which is why the schema route exists; removing it is a separate decision.
