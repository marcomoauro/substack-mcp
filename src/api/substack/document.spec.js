import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
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

// Guarded the way CLAUDE.md documents for callTool results: reading .error.issues on a parse that
// unexpectedly succeeded throws a TypeError that buries the real diff under an unrelated stack.
const issues = (value) => {
  const result = parse(value);

  assert.equal(result.success, false, 'expected the parse to fail, but it succeeded');
  return result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
};

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

  test('accepts a heading with no content at all', () => {
    assert.equal(parse(doc({type: 'heading', attrs: {level: 2}})).success, true);
  });

  test('rejects heading level 0', () => {
    assert.equal(parse(doc({type: 'heading', attrs: {level: 0}, content: [text('T')]})).success, false);
  });

  test('rejects a fractional heading level', () => {
    assert.equal(parse(doc({type: 'heading', attrs: {level: 2.5}, content: [text('T')]})).success, false);
  });
});

describe('postBodySchema — strictness', () => {
  // CLAUDE.md: a plain z.object strips unknown keys silently, which would delete a node key this
  // schema does not model from a read-modify-write round trip. strictObject is what turns that into
  // a reported error instead, so every node level gets its own check rather than trusting one.
  test('rejects an unknown key on the document root, naming it', () => {
    assert.match(issues({type: 'doc', content: [], bogus: true}).join(' '), /Unrecognized key.*bogus/);
  });

  test('rejects an unknown key on a paragraph node, naming it', () => {
    assert.match(issues(doc({type: 'paragraph', content: [], bogus: true})).join(' '), /Unrecognized key.*bogus/);
  });

  test('rejects an unknown key on a heading node, naming it', () => {
    const node = {type: 'heading', attrs: {level: 1}, content: [text('T')], bogus: true};

    assert.match(issues(doc(node)).join(' '), /Unrecognized key.*bogus/);
  });

  test('rejects an unknown key on a text node, naming it', () => {
    const node = {type: 'text', text: 'x', bogus: true};

    assert.match(issues(doc({type: 'paragraph', content: [node]})).join(' '), /Unrecognized key.*bogus/);
  });

  test('rejects a text node with no text', () => {
    assert.equal(parse(doc({type: 'paragraph', content: [{type: 'text'}]})).success, false);
  });
});

describe('postBodySchema — descriptions', () => {
  // Regression guard for the exact hazard CLAUDE.md records: this schema publishes as a tool's
  // JSON Schema and the description is the only vocabulary a calling model gets, so stripping any
  // .describe() call must fail a test, not just read badly. z.toJSONSchema with these exact options
  // is the call the SDK itself makes (server/zod-json-schema-compat.js), not an approximation of it.
  //
  // The walk covers the whole converted schema, not just the top-level document union: list_item,
  // image2 and caption (Tasks 2-4) are reachable only nested — inside list nodes and inside
  // captionedImage — never as a top-level branch, and marks are nested under every text node. A
  // check that only indexed into content.items.oneOf would be blind to exactly the nodes and marks
  // that live one level down.
  test('every node and mark in the published schema carries a description', () => {
    const json = z.toJSONSchema(postBodySchema, {target: 'draft-7', io: 'input'});
    const missing = [];

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const branch of node.oneOf ?? []) {
        const name = branch.properties?.type?.const;
        if (name && !branch.description) missing.push(name);
      }
      for (const value of Object.values(node)) walk(value);
    };

    walk(json);
    assert.deepEqual(missing, [], `undescribed: ${missing.join(', ')}`);
  });
});

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
