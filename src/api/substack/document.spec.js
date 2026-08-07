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
  // JSON Schema and the description is the only vocabulary a calling model gets, so stripping every
  // .describe() call must fail a test, not just read badly. z.toJSONSchema with these exact options
  // is the call the SDK itself makes (server/zod-json-schema-compat.js), not an approximation of it.
  test('every content node carries a description in the published schema', () => {
    const json = z.toJSONSchema(postBodySchema, {target: 'draft-7', io: 'input'});
    const branches = json.properties.content.items.oneOf;

    assert.ok(branches.length > 0);
    for (const branch of branches) {
      assert.ok(branch.description, `${branch.properties.type.const} node has no description`);
    }
  });
});
