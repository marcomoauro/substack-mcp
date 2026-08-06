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
