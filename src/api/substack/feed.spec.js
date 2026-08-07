import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeFeed, summarizeFeedItem} from './feed.js';
import {READER_FEED_RESPONSE} from '../../../test/helpers/msw-server.js';
import {setTestEnv} from '../../../test/helpers/env.js';

setTestEnv();

const [NOTE_ITEM, POST_ITEM, SUGGESTIONS_ITEM] = READER_FEED_RESPONSE.items;

describe('summarizeFeedItem', () => {
  test('summarizes a Note as type note, through the comment summarizer', () => {
    const result = summarizeFeedItem(NOTE_ITEM);

    assert.equal(result.type, 'note');
    assert.equal(result.id, 306029118);
    assert.equal(result.author, 'Stephane Moreau');
    assert.equal(result.publication, 'Someone’s Publication');
    assert.equal(result.can_reply, true);
    assert.equal(result.surfaced_at, '2026-08-07T10:03:00.251Z');
  });

  test('summarizes a post as type post', () => {
    const result = summarizeFeedItem(POST_ITEM);

    assert.equal(result.type, 'post');
    assert.equal(result.id, 204305990);
    assert.equal(result.title, 'A Feed Post');
    assert.equal(result.author, 'Alex Pozzi');
    assert.equal(result.preview_text, 'A teaser…');
  });

  // A feed of 20 posts carrying body_html runs to hundreds of KB. The teaser is what a feed is for.
  test('drops the post body, keeping only the teaser', () => {
    assert.ok(POST_ITEM.post.body_html, 'the fixture must carry a body to drop');
    assert.ok(!('body_html' in summarizeFeedItem(POST_ITEM)));
  });

  // The item has no id, no author and no body. Summarized rather than dropped it becomes an entry
  // full of nulls, which reads as empty content instead of as something that was never content.
  test('drops a userSuggestions block entirely', () => {
    assert.equal(summarizeFeedItem(SUGGESTIONS_ITEM), null);
  });

  test('drops an item type it has never seen, rather than half-summarizing it', () => {
    assert.equal(summarizeFeedItem({type: 'somethingNew', payload: {}}), null);
  });

  test('drops the ranking telemetry', () => {
    const result = summarizeFeedItem(NOTE_ITEM);

    assert.ok(NOTE_ITEM.context.model_score, 'the fixture must carry telemetry to drop');
    assert.ok(!('context' in result));
    assert.ok(!('model_score' in result));
  });

  test('carries the parent comments a reply answers', () => {
    const reply = {
      ...NOTE_ITEM,
      parentComments: [{id: 1, name: 'Asker', body: 'The question'}],
    };

    assert.deepEqual(summarizeFeedItem(reply).replying_to, [
      {id: 1, author: 'Asker', body: 'The question'},
    ]);
  });

  test('returns null for a missing item', () => {
    assert.equal(summarizeFeedItem(null), null);
  });
});

describe('summarizeFeed', () => {
  test('returns the content items and the cursor', () => {
    const result = summarizeFeed(READER_FEED_RESPONSE);

    assert.equal(result.returned, 2);
    assert.equal(result.next_cursor, 'next-page-cursor');
    assert.deepEqual(result.items.map((item) => item.type), ['note', 'post']);
  });

  // Without this count, a page that was mostly suggestion blocks looks like a nearly empty feed
  // rather than a page that held little content.
  test('reports how many entries carried no content', () => {
    assert.equal(summarizeFeed(READER_FEED_RESPONSE).non_content_items_skipped, 1);
  });

  test('omits the count when every entry was content', () => {
    const payload = {items: [READER_FEED_RESPONSE.items[0]], nextCursor: null};

    assert.ok(!('non_content_items_skipped' in summarizeFeed(payload)));
  });

  test('applies the limit after dropping non-content entries', () => {
    const result = summarizeFeed(READER_FEED_RESPONSE, {limit: 1});

    assert.equal(result.returned, 1);
    assert.equal(result.items[0].type, 'note');
  });

  test('survives an empty or missing payload', () => {
    assert.deepEqual(summarizeFeed({}), {returned: 0, next_cursor: null, items: []});
    assert.deepEqual(summarizeFeed(null), {returned: 0, next_cursor: null, items: []});
  });
});
