import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {parseAncestorPath, summarizeComment} from './comment.js';
import {setTestEnv} from '../../../test/helpers/env.js';

// The subject logs nothing, but setTestEnv is cheap and keeps this file honest if it ever does.
setTestEnv();

describe('parseAncestorPath', () => {
  // The three shapes observed live, at depths 0, 1 and 2.
  test('treats an empty path as a root comment', () => {
    assert.deepEqual(parseAncestorPath(''), {parent_comment_id: null, depth: 0});
  });

  test('reads a single ancestor as the parent', () => {
    assert.deepEqual(parseAncestorPath('309007328'), {parent_comment_id: 309007328, depth: 1});
  });

  // The one that matters: the path is root-first, so the parent is the LAST segment. Taking the
  // first would name the thread's root as the parent of every nested reply.
  test('takes the parent from the end of a dot-separated chain, not the start', () => {
    assert.deepEqual(parseAncestorPath('309007328.309403526'), {
      parent_comment_id: 309403526,
      depth: 2,
    });
  });

  test('handles a three-deep chain', () => {
    assert.deepEqual(parseAncestorPath('1.2.3'), {parent_comment_id: 3, depth: 3});
  });

  test('survives a missing or non-string path', () => {
    assert.deepEqual(parseAncestorPath(undefined), {parent_comment_id: null, depth: 0});
    assert.deepEqual(parseAncestorPath(null), {parent_comment_id: null, depth: 0});
  });

  test('reports a non-numeric ancestor as unknown rather than NaN', () => {
    assert.deepEqual(parseAncestorPath('abc'), {parent_comment_id: null, depth: 1});
  });
});

describe('summarizeComment', () => {
  const COMMENT = {
    id: 309403526,
    name: 'A Reader',
    handle: 'areader',
    user_id: 22563751,
    body: 'A comment',
    body_json: {type: 'doc', content: [{type: 'paragraph'}]},
    post_id: 167712345,
    publication_id: 2150088,
    date: '2026-08-01T11:00:00.000Z',
    edited_at: '2026-08-01T11:05:00.000Z',
    ancestor_path: '309007328',
    reaction_count: 4,
    restacks: 2,
    children_count: 7,
    attachments: [{id: 1}, {id: 2}],
  };

  test('reads the flat author fields', () => {
    const result = summarizeComment(COMMENT);

    // Flat, not nested under `user` — reading `comment.user.name` yields undefined against the
    // real payload.
    assert.equal(result.author, 'A Reader');
    assert.equal(result.author_handle, 'areader');
    assert.equal(result.author_user_id, 22563751);
  });

  test('counts replies from children_count, not a children array', () => {
    assert.equal(summarizeComment(COMMENT).reply_count, 7);
  });

  // Two shapes exist, both measured. Creating a comment answers with the collections and *no* counts,
  // and the create path runs through this same summarizer — so reading only the counts reports a
  // freshly created comment's replies and reactions as absent rather than as zero-or-more.
  test('falls back to the collections the create response carries instead of counts', () => {
    const created = {
      id: 309931681,
      name: 'Marco Moauro',
      body: 'A new comment',
      ancestor_path: '',
      children: [{id: 1}, {id: 2}],
      reactions: {'❤': 3},
    };

    const result = summarizeComment(created);

    assert.equal(result.reply_count, 2);
    assert.equal(result.reactions, 1);
  });

  test('prefers the counts when both shapes are present', () => {
    const both = {...COMMENT, children: [{id: 1}], reactions: {'❤': 1}};

    assert.equal(summarizeComment(both).reply_count, 7);
    assert.equal(summarizeComment(both).reactions, 4);
  });

  test('resolves the thread position from ancestor_path', () => {
    const result = summarizeComment(COMMENT);

    assert.equal(result.parent_comment_id, 309007328);
    assert.equal(result.depth, 1);
  });

  test('keeps the plain-text body and drops the ProseMirror duplicate', () => {
    const result = summarizeComment(COMMENT);

    assert.equal(result.body, 'A comment');
    assert.ok(!('body_json' in result), 'body_json is several times the size and adds nothing');
  });

  test('counts attachments rather than inlining them', () => {
    assert.equal(summarizeComment(COMMENT).attachment_count, 2);
  });

  // A Note is the same entity with no post: this is how a caller tells them apart.
  test('reports a Note as having no post_id', () => {
    const note = {...COMMENT, post_id: null, type: 'feed'};

    assert.equal(summarizeComment(note).post_id, null);
  });

  test('returns null for a missing comment', () => {
    assert.equal(summarizeComment(null), null);
    assert.equal(summarizeComment(undefined), null);
  });

  test('defaults the counters on a sparse comment', () => {
    const result = summarizeComment({id: 1});

    assert.equal(result.reactions, 0);
    assert.equal(result.restacks, 0);
    assert.equal(result.reply_count, 0);
    assert.equal(result.attachment_count, 0);
    assert.equal(result.depth, 0);
  });
});
