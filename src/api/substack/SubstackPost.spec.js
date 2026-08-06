import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import SubstackPost from './SubstackPost.js';

describe('SubstackPost — costruttore', () => {
  test('applica i default e converte user_id a intero', () => {
    const post = new SubstackPost({user_id: '12345'});

    assert.equal(post.draft_title, null);
    assert.equal(post.draft_subtitle, null);
    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
    assert.deepEqual(post.draft_bylines, [{id: 12345, is_guest: false}]);
    assert.equal(post.audience, 'everyone');
    assert.equal(post.draft_section_id, null);
    assert.equal(post.section_chosen, true);
  });

  test('accetta titolo e sottotitolo dal costruttore', () => {
    const post = new SubstackPost({user_id: '1', title: 'T', subtitle: 'S'});

    assert.equal(post.draft_title, 'T');
    assert.equal(post.draft_subtitle, 'S');
  });

  test('write_comment_permissions segue audience quando non specificato', () => {
    const post = new SubstackPost({user_id: '1', audience: 'only_paid'});

    assert.equal(post.audience, 'only_paid');
    assert.equal(post.write_comment_permissions, 'only_paid');
  });

  test('write_comment_permissions esplicito vince su audience', () => {
    const post = new SubstackPost({
      user_id: '1',
      audience: 'only_paid',
      write_comment_permissions: 'everyone',
    });

    assert.equal(post.write_comment_permissions, 'everyone');
  });

  test('senza subscriber_set_id non imposta subscriber_set_id né type', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.equal(post.subscriber_set_id, undefined);
    assert.equal(post.type, undefined);
  });

  test('con subscriber_set_id imposta anche type adhoc_email', () => {
    const post = new SubstackPost({user_id: '1', subscriber_set_id: 77});

    assert.equal(post.subscriber_set_id, 77);
    assert.equal(post.type, 'adhoc_email');
  });
});

describe('SubstackPost — setter', () => {
  test('setTitle, setSubtitle e setBody aggiornano lo stato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setTitle('Nuovo titolo');
    post.setSubtitle('Nuovo sottotitolo');
    post.setBody({type: 'doc', content: [{type: 'paragraph'}]});

    assert.equal(post.draft_title, 'Nuovo titolo');
    assert.equal(post.draft_subtitle, 'Nuovo sottotitolo');
    assert.deepEqual(post.draft_body, {type: 'doc', content: [{type: 'paragraph'}]});
  });
});

describe('SubstackPost — getDraft', () => {
  test('serializza draft_body in stringa e conserva le altre proprietà', () => {
    const post = new SubstackPost({user_id: '42', title: 'T', subtitle: 'S'});

    const draft = post.getDraft();

    assert.equal(draft.draft_title, 'T');
    assert.equal(draft.draft_subtitle, 'S');
    assert.deepEqual(draft.draft_bylines, [{id: 42, is_guest: false}]);
    assert.equal(draft.audience, 'everyone');
    assert.equal(typeof draft.draft_body, 'string');
    assert.equal(draft.draft_body, '{"type":"doc","content":[]}');
  });

  test('non muta l\'istanza', () => {
    const post = new SubstackPost({user_id: '1'});

    post.getDraft();

    assert.deepEqual(post.draft_body, {type: 'doc', content: []});
  });

  // CARATTERIZZAZIONE — comportamento corrente, probabile anomalia.
  // createDraftPostHandler passa una stringa a setBody, quindi getDraft applica
  // JSON.stringify a una stringa e draft_body finisce doppiamente serializzato.
  test('setBody con una stringa produce un draft_body doppiamente serializzato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setBody('testo semplice');

    assert.equal(post.getDraft().draft_body, '"testo semplice"');
  });
});

describe('SubstackPost — blocchi di contenuto', () => {
  test('paragraph con testo semplice', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('Ciao');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', text: 'Ciao'}]},
    ]);
  });

  test('paragraph senza argomenti produce un paragrafo vuoto', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph();

    assert.deepEqual(post.draft_body.content, [{type: 'paragraph'}]);
  });

  test('heading imposta attrs.level', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Titolo', level: 2});

    assert.deepEqual(post.draft_body.content, [
      {type: 'heading', content: [{type: 'text', text: 'Titolo'}], attrs: {level: 2}},
    ]);
  });

  test('heading usa level 1 come default', () => {
    const post = new SubstackPost({user_id: '1'});

    post.heading({content: 'Titolo'});

    assert.equal(post.draft_body.content[0].attrs.level, 1);
  });

  test('horizontalRule e paywall', () => {
    const post = new SubstackPost({user_id: '1'});

    post.horizontalRule();
    post.paywall();

    assert.deepEqual(post.draft_body.content, [
      {type: 'horizontal_rule'},
      {type: 'paywall'},
    ]);
  });

  test('bulletList costruisce list_item annidati', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bulletList(['uno', 'due']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'uno'}]}]},
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'due'}]}]},
        ],
      },
    ]);
  });

  test('orderedList aggiunge attrs start/order', () => {
    const post = new SubstackPost({user_id: '1'});

    post.orderedList(['uno']);

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'ordered_list',
        attrs: {start: 1, order: 1},
        content: [
          {type: 'list_item', content: [{type: 'paragraph', content: [{type: 'text', text: 'uno'}]}]},
        ],
      },
    ]);
  });

  test('bold e italic producono paragrafi con i mark corrispondenti', () => {
    const post = new SubstackPost({user_id: '1'});

    post.bold('grassetto');
    post.italic('corsivo');

    assert.deepEqual(post.draft_body.content, [
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'strong'}], text: 'grassetto'}]},
      {type: 'paragraph', content: [{type: 'text', marks: [{type: 'em'}], text: 'corsivo'}]},
    ]);
  });

  test('shareButton, commentButton e customButton', () => {
    const post = new SubstackPost({user_id: '1'});

    post.shareButton();
    post.commentButton();
    post.customButton({url: 'https://example.com', text: 'Vai'});

    assert.deepEqual(post.draft_body.content, [
      {type: 'button', attrs: {url: '%%share_url%%', text: 'Share', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: '%%half_magic_comments_url%%', text: 'Leave a comment', action: null, class: 'button-wrapper'}},
      {type: 'button', attrs: {url: 'https://example.com', text: 'Vai', action: null, class: 'button-wrapper'}},
    ]);
  });

  test('removeLastParagraph rimuove l\'ultimo blocco', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph('primo');
    post.paragraph('secondo');
    post.removeLastParagraph();

    assert.equal(post.draft_body.content.length, 1);
    assert.deepEqual(post.draft_body.content[0].content, [{type: 'text', text: 'primo'}]);
  });

  // CARATTERIZZAZIONE — add() passa l'intero item a captionedImage(), quindi item.type
  // (il tipo del nodo, 'captionedImage') sovrascrive il default `type = null`
  // dell'attributo omonimo di image2. Il default è irraggiungibile per questa via, che è
  // anche l'unica praticabile: chiamare captionedImage() direttamente lancia, perché legge
  // l'ultimo nodo di draft_body.content, che a quel punto non esiste.
  test('captionedImage annida un nodo image2 e gli attrs.type ereditano il tipo del nodo', () => {
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
    ['URL youtube.com con parametro v', 'https://www.youtube.com/watch?v=0chZFIZLR_0'],
    ['URL breve youtu.be', 'https://youtu.be/0chZFIZLR_0?si=-Gp9e_RKG3g1SdVG'],
    ['ID nudo', '0chZFIZLR_0'],
  ];

  for (const [label, input] of cases) {
    test(`estrae il video id da: ${label}`, () => {
      const post = new SubstackPost({user_id: '1'});

      post.youtubeVideo(input);

      assert.deepEqual(post.draft_body.content, [
        {type: 'youtube2', attrs: {videoId: '0chZFIZLR_0'}},
      ]);
    });
  }
});

describe('SubstackPost — testo con mark', () => {
  test('addComplexText con un array applica i mark per chunk', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'in grassetto', marks: [{type: 'strong'}]},
      {content: ' e normale'},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {type: 'text', text: 'in grassetto', marks: [{type: 'strong'}]},
      {type: 'text', text: ' e normale', marks: []},
    ]);
  });

  test('un mark link produce attrs.href', () => {
    const post = new SubstackPost({user_id: '1'});

    post.paragraph([
      {content: 'clicca qui', marks: [{type: 'link', href: 'https://example.com'}]},
    ]);

    assert.deepEqual(post.draft_body.content[0].content, [
      {
        type: 'text',
        text: 'clicca qui',
        marks: [{type: 'link', attrs: {href: 'https://example.com'}}],
      },
    ]);
  });
});

describe('SubstackPost — setSection', () => {
  test('imposta draft_section_id quando la sezione esiste', () => {
    const post = new SubstackPost({user_id: '1'});

    post.setSection('News', [{name: 'Altro', id: 1}, {name: 'News', id: 7}]);

    assert.equal(post.draft_section_id, 7);
  });

  test('lancia quando la sezione non esiste', () => {
    const post = new SubstackPost({user_id: '1'});

    assert.throws(
      () => post.setSection('Mancante', [{name: 'News', id: 7}]),
      /Section Mancante does not exist/
    );
  });
});

describe('SubstackPost — subscribeWidget', () => {
  test('add con subscribeWidget senza messaggio usa il testo di default', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget'});

    const [node] = post.draft_body.content;
    assert.equal(node.type, 'subscribeWidget');
    assert.deepEqual(node.attrs, {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'});
    assert.equal(node.content[0].type, 'ctaCaption');
    assert.match(node.content[0].content[0].text, /^Thanks for reading this newsletter!/);
    assert.match(node.content[0].content[0].text, /Subscribe for free/);
  });

  test('add con subscribeWidget e messaggio personalizzato', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'subscribeWidget', message: 'Messaggio mio'});

    assert.equal(post.draft_body.content[0].content[0].content[0].text, 'Messaggio mio');
  });

  // CARATTERIZZAZIONE — comportamento corrente, probabile copia-incolla dal ramo
  // subscribeWidget: add() con type 'bullet_list' applica la caption di iscrizione
  // invece di costruire una lista.
  test('add con bullet_list applica la caption di iscrizione', () => {
    const post = new SubstackPost({user_id: '1'});

    post.add({type: 'bullet_list', message: 'Messaggio mio'});

    assert.deepEqual(post.draft_body.content, [
      {
        type: 'bullet_list',
        attrs: {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'},
        content: [{type: 'ctaCaption', content: [{type: 'text', text: 'Messaggio mio'}]}],
      },
    ]);
  });
});
