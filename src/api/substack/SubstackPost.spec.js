import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import SubstackPost from './SubstackPost.js';
import {setTestEnv} from '../../../test/helpers/env.js';
import {captureLogs} from '../../../test/helpers/capture-logs.js';

let restoreEnv;

// setTestEnv is here for its SUBSTACK_MCP_LOG_LEVEL=silent: this file reads no env var, but the
// constructor and every setter log, and the lines would otherwise land in the reporter output.
before(() => {
  restoreEnv = setTestEnv();
});

after(() => {
  restoreEnv();
});

describe('SubstackPost — constructor', () => {
  test('applies the defaults and coerces user_id to an integer', () => {
    const post = new SubstackPost({user_id: '12345'});

    assert.equal(post.draft_title, null);
    assert.equal(post.draft_subtitle, null);
    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
    assert.deepEqual(post.draft_bylines, [{id: 12345, is_guest: false}]);
    assert.equal(post.audience, 'everyone');
    assert.equal(post.draft_section_id, null);
    assert.equal(post.section_chosen, true);
  });

  test('accepts title and subtitle from the constructor', () => {
    const post = new SubstackPost({user_id: '1', title: 'T', subtitle: 'S'});

    assert.equal(post.draft_title, 'T');
    assert.equal(post.draft_subtitle, 'S');
  });

  test('write_comment_permissions follows audience when not given', () => {
    const post = new SubstackPost({user_id: '1', audience: 'only_paid'});

    assert.equal(post.audience, 'only_paid');
    assert.equal(post.write_comment_permissions, 'only_paid');
  });

  test('an explicit write_comment_permissions wins over audience', () => {
    const post = new SubstackPost({
      user_id: '1',
      audience: 'only_paid',
      write_comment_permissions: 'everyone',
    });

    assert.equal(post.write_comment_permissions, 'everyone');
  });

  test('without subscriber_set_id it sets neither subscriber_set_id nor type', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.equal(post.subscriber_set_id, undefined);
    assert.equal(post.type, undefined);
  });

  test('with subscriber_set_id it also sets type to adhoc_email', () => {
    const post = new SubstackPost({user_id: '1', subscriber_set_id: 77});

    assert.equal(post.subscriber_set_id, 77);
    assert.equal(post.type, 'adhoc_email');
  });
});

describe('SubstackPost — setters', () => {
  test('setTitle, setSubtitle and setBody update the state', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setTitle('New title');
    post.setSubtitle('New subtitle');
    post.setBody({type: 'doc', content: [{type: 'paragraph'}]});

    assert.equal(post.draft_title, 'New title');
    assert.equal(post.draft_subtitle, 'New subtitle');
    assert.deepEqual(post.draft_body, {type: 'doc', content: [{type: 'paragraph'}]});
  });
});

describe('SubstackPost — getDraft', () => {
  test('serializes draft_body to a string and keeps the other properties', () => {
    const post = new SubstackPost({user_id: '42', title: 'T', subtitle: 'S'});

    const draft = post.getDraft();

    assert.equal(draft.draft_title, 'T');
    assert.equal(draft.draft_subtitle, 'S');
    assert.deepEqual(draft.draft_bylines, [{id: 42, is_guest: false}]);
    assert.equal(draft.audience, 'everyone');
    assert.equal(typeof draft.draft_body, 'string');
    assert.equal(draft.draft_body, '{"type":"doc","content":[]}');
  });

  test('does not mutate the instance', () => {
    const post = new SubstackPost({user_id: '1'});

    post.getDraft();

    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
  });

  // CHARACTERIZATION — current behaviour of the builder itself. Handing setBody a string
  // makes getDraft apply JSON.stringify to a string, double-serializing draft_body.
  // createDraftPostHandler no longer does this (see #4), but the class still allows it.
  test('setBody with a string produces a double-serialized draft_body', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setBody('testo semplice');

    assert.equal(post.getDraft().draft_body, '"testo semplice"');
  });
});

describe('SubstackPost — logging', () => {
  function find(lines, msg) {
    const line = lines.find((entry) => entry.msg === msg);
    assert.ok(line, `expected a ${msg} log line, got: ${lines.map((l) => l.msg).join(', ')}`);
    return line;
  }

  test('the constructor records the fields it derived', async () => {
    const lines = await captureLogs(() => new SubstackPost({user_id: '42', title: 'T'}));

    const created = find(lines, 'draft.created');
    assert.equal(created.draft_title, 'T');
    assert.deepEqual(created.draft_bylines, [{id: 42, is_guest: false}]);
    assert.equal(created.audience, 'everyone');
  });

  test('each setter records what it was given', async () => {
    const post = new SubstackPost({user_id: '1'});

    const lines = await captureLogs(() => {
      post.setTitle('New title');
      post.setSubtitle('New subtitle');
      post.setBody({type: 'doc', content: [{type: 'paragraph'}]});
    });

    assert.equal(find(lines, 'draft.setTitle').title, 'New title');
    assert.equal(find(lines, 'draft.setSubtitle').subtitle, 'New subtitle');
    assert.deepEqual(find(lines, 'draft.setBody').body.content, [{type: 'paragraph'}]);
  });

  test('getDraft records the payload that is about to be sent', async () => {
    const post = new SubstackPost({user_id: '1', title: 'T'});

    const lines = await captureLogs(() => post.getDraft());

    const {draft} = find(lines, 'draft.getDraft');
    assert.equal(draft.draft_title, 'T');
    assert.equal(draft.draft_body, '{"type":"doc","content":[]}');
  });

  test('a section is recorded, and an unknown one names the available sections', async () => {
    const post = new SubstackPost({user_id: '1'});
    const sections = [{name: 'News', id: 7}];

    const lines = await captureLogs(() => {
      post.setSection('News', sections);
      assert.throws(() => post.setSection('Missing', sections));
    });

    assert.equal(find(lines, 'draft.setSection').name, 'News');

    // The thrown message names only what was asked for; the log is where a caller can see what
    // it should have asked for instead.
    const unknown = find(lines, 'draft.setSection.unknown');
    assert.equal(unknown.name, 'Missing');
    assert.deepEqual(unknown.available, ['News']);
  });
});

describe('SubstackPost — content blocks', () => {
  test('paragraph with plain text', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('Hello');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', text: 'Hello'}]},
    ]);
  });

  test('paragraph with no arguments produces an empty paragraph', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph();

    assert.deepEqual(post.draft_body.content, [{type: 'paragraph'}]);
  });

  test('heading sets attrs.level', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Heading', level: 2});

    assert.deepEqual(post.draft_body.content, [
      {type: 'heading', content: [{type: 'text', text: 'Heading'}], attrs: {level: 2}},
    ]);
  });

  test('heading defaults to level 1', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Heading'});

    assert.equal(post.draft_body.content[0].attrs.level, 1);
  });

  test('horizontalRule and paywall', () => {
    const post = new SubstackPost({user_id: '1'});

    post.horizontalRule();
    post.paywall();

    assert.deepEqual(post.draft_body.content, [
      {type: 'horizontal_rule'},
      {type: 'paywall'},
    ]);
  });

  test('bulletList builds nested list_item nodes', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bulletList(['one', 'two']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'one'}]}]},
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'two'}]}]},
        ],
      },
    ]);
  });

  test('orderedList adds the start/order attrs', () => {
    const post = new SubstackPost({user_id: '1'});

    post.orderedList(['one']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'ordered_list',
        attrs: {start: 1, order: 1},
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'one'}]}]},
        ],
      },
    ]);
  });

  test('bold and italic produce paragraphs with the matching marks', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bold('bold text');
    post.italic('italic text');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'strong'}], text: 'bold text'}]},
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'em'}], text: 'italic text'}]},
    ]);
  });

  test('shareButton, commentButton and customButton', () => {
    const post = new SubstackPost({user_id: '1'});

    post.shareButton();
    post.commentButton();
    post.customButton({url: 'https://example.com', text: 'Go'});

    assert.deepEqual(post.draft_body.content, [
      {type: 'button', attrs: {url: '%%share_url%%', text: 'Share', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: '%%half_magic_comments_url%%', text: 'Leave a comment', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: 'https://example.com', text: 'Go', action: null, class: 'button-wrapper'}},
    ]);
  });

  test('removeLastParagraph drops the last block', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('first');
    post.paragraph('second');
    post.removeLastParagraph();

    assert.equal(post.draft_body.content.length, 1);
    assert.deepEqual(post.draft_body.content[0].content, [{type: 'text', text: 'first'}]);
  });

  // CHARACTERIZATION — add() passes the whole item to captionedImage(), so item.type (the
  // node type, 'captionedImage') overrides the `type = null` default of image2's attribute
  // of the same name. The default is unreachable through this path, which is also the only
  // usable one: calling captionedImage() directly throws, because it reads the last node of
  // draft_body.content, which does not exist yet.
  test('captionedImage nests an image2 node whose attrs.type inherits the node type', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'captionedImage', src: 'https://img.example/a.png'});

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'captionedImage',
        content: [
          {
            type: 'image2',
            attrs: {
              src: 'https://img.example/a.png',
              fullscreen: false,
              imageSize: 'normal',
              height: 819,
              width: 1456,
              resizeWidth: 728,
              bytes: null,
              alt: null,
              title: null,
              type: 'captionedImage',
              href: null,
              belowTheFold: false,
              internalRedirect: null,
            },
          },
        ],
      },
    ]);
  });
});

describe('SubstackPost — youtubeVideo', () => {
  const cases = [
    ['a youtube.com URL with a v parameter', 'https://www.youtube.com/watch?v=0chZFIZLR_0'],
    ['a short youtu.be URL', 'https://youtu.be/0chZFIZLR_0?si=-Gp9e_RKG3g1SdVG'],
    ['a bare id', '0chZFIZLR_0'],
  ];

  for (const [label, input] of cases) {
    test(`extracts the video id from ${label}`, () => {
      const post = new SubstackPost({user_id: '1'});

      post.youtubeVideo(input);

      assert.deepEqual(post.draft_body.content, [
        {type: 'youtube2', attrs: {videoId: '0chZFIZLR_0'}},
      ]);
    });
  }
});

describe('SubstackPost — marked text', () => {
  test('addComplexText with an array applies marks per chunk', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'in bold', marks: [{type: 'strong'}]},
      {content: ' and plain'},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {type: 'text', text: 'in bold', marks: [{type: 'strong'}]},
      {type: 'text', text: ' and plain', marks: []},
    ]);
  });

  test('a link mark produces attrs.href', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'click here', marks: [{type: 'link', href: 'https://example.com'}]},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {
        type: 'text',
        text: 'click here',
        marks: [{type: 'link', attrs: {href: 'https://example.com'}}],
      },
    ]);
  });
});

describe('SubstackPost — setSection', () => {
  test('sets draft_section_id when the section exists', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setSection('News', [{name: 'Other', id: 1}, {name: 'News', id: 7}]);

    assert.equal(post.draft_section_id, 7);
  });

  test('throws when the section does not exist', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.throws(
      () => post.setSection('Missing', [{name: 'News', id: 7}]),
      /Section Missing does not exist/
    );
  });
});

describe('SubstackPost — subscribeWidget', () => {
  test('add with subscribeWidget and no message uses the default text', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget'});

    const [node] = post.draft_body.content;
    assert.equal(node.type, 'subscribeWidget');
    assert.deepEqual(node.attrs, {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'});
    assert.equal(node.content[0].type, 'ctaCaption');
    assert.match(node.content[0].content[0].text, /^Thanks for reading this newsletter!/);
    assert.match(node.content[0].content[0].text, /Subscribe for free/);
  });

  test('add with subscribeWidget and a custom message', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget', message: 'My message'});

    assert.equal(post.draft_body.content[0].content[0].content[0].text, 'My message');
  });

  // CHARACTERIZATION — current behaviour, most likely copy-paste from the subscribeWidget
  // branch: add() with type 'bullet_list' applies the subscribe caption instead of
  // building a list.
  test('add with bullet_list applies the subscribe caption', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'bullet_list', message: 'My message'});

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        attrs: {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'},
        content: [{type: 'ctaCaption', content: [{type: 'text', text: 'My message'}]}],
      },
    ]);
  });
});
