import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {getReaderFeedHandler, getReaderFeedSchema} from './get_reader_feed.js';
import {createMswServer} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';

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

describe('getReaderFeedSchema', () => {
  test('defaults to the for-you tab', () => {
    assert.deepEqual(getReaderFeedSchema.parse({}), {
      tab: 'for-you',
      limit: 20,
      include_tabs: false,
    });
  });

  test('bounds the limit at 50', () => {
    assert.throws(() => getReaderFeedSchema.parse({limit: 51}), z.ZodError);
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => getReaderFeedSchema.parse({type: 'notes'}),
      (error) => /Unrecognized key/.test(error.message) && /\btype\b/.test(error.message)
    );
  });

  // The tab names are localized, so the schema must steer a caller to the id.
  test('says to use the tab id rather than its name', () => {
    const json = z.toJSONSchema(getReaderFeedSchema, {target: 'draft-7', io: 'input'});

    assert.equal(json.additionalProperties, false);
    assert.match(json.properties.tab.description, /localized/);
  });
});

describe('getReaderFeedHandler', () => {
  test('reads substack.com with the tab and limit', async () => {
    await getReaderFeedHandler({tab: 'subscribed', limit: 5});

    const url = new URL(msw.requests.at(-1).url);

    assert.equal(url.origin, 'https://substack.com');
    assert.equal(url.pathname, '/api/v1/reader/feed');
    assert.equal(url.searchParams.get('tab'), 'subscribed');
    assert.ok(!url.searchParams.has('cursor'), 'a null cursor must not be serialized');
  });

  test('summarizes the feed and returns the cursor', async () => {
    const result = await getReaderFeedHandler({});

    assert.equal(result.tab, 'for-you');
    assert.equal(result.returned, 2);
    assert.deepEqual(result.items.map((item) => item.type), ['note', 'post']);
    assert.equal(result.next_cursor, 'next-page-cursor');
  });

  test('reports the suggestion block it dropped', async () => {
    assert.equal((await getReaderFeedHandler({})).non_content_items_skipped, 1);
  });

  test('does not fetch the tabs unless asked', async () => {
    await getReaderFeedHandler({});

    assert.ok(!msw.requests.some((request) => request.url.endsWith('/reader/feed/tabs')));
  });

  test('returns the tab ids alongside their localized names when asked', async () => {
    const result = await getReaderFeedHandler({include_tabs: true});

    assert.deepEqual(result.available_tabs, [
      {id: 'for-you', name: 'Per te', type: 'base'},
      {id: 'subscribed', name: 'Segui già', type: 'secondary'},
    ]);
  });

  test('forwards a cursor when resuming', async () => {
    await getReaderFeedHandler({cursor: 'next-page-cursor'});

    assert.equal(
      new URL(msw.requests.at(-1).url).searchParams.get('cursor'),
      'next-page-cursor'
    );
  });

  test('propagates a failing status as an error', async () => {
    msw.server.use(msw.readerFeedHandler(() => HttpResponse.json({}, {status: 429})));

    await assert.rejects(() => getReaderFeedHandler({}), /SubstackAPIException: 429/);
  });
});
