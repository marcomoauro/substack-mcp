import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {markdownToDoc, MarkdownConversionError} from './markdown.js';
import {postBodySchema} from './document.js';

// Synthetic Markdown only. The expected nodes are the shapes `postBodySchema` accepts, which were read
// off the live editor (see document.js); this suite checks the mapping onto them, not Substack.

const IMG = 'https://substack-post-media.s3.amazonaws.com/public/images/a.png';
const doc = (...content) => ({type: 'doc', content});
const p = (...content) => ({type: 'paragraph', content});
const t = (text, ...marks) => (marks.length ? {type: 'text', text, marks} : {type: 'text', text});
const li = (...content) => ({type: 'list_item', content});

describe('markdownToDoc — what converts', () => {
  const cases = [
    ['an empty string', '', doc()],
    ['a paragraph', 'Hello.', doc(p(t('Hello.')))],
    ['two paragraphs', 'One.\n\nTwo.', doc(p(t('One.')), p(t('Two.')))],
    ['a soft line break as a space', 'one\ntwo', doc(p(t('one two')))],
    ['a hard break from two trailing spaces', 'one  \ntwo', doc(p(t('one'), {type: 'hard_break'}, t('two')))],
    ['a hard break from a backslash', 'one\\\ntwo', doc(p(t('one'), {type: 'hard_break'}, t('two')))],
    ...[1, 2, 3, 4, 5, 6].map((level) => [
      `a level ${level} heading`, `${'#'.repeat(level)} Title`,
      doc({type: 'heading', attrs: {level}, content: [t('Title')]}),
    ]),
    ['bold', '**b**', doc(p(t('b', {type: 'strong'})))],
    ['italic', '*i*', doc(p(t('i', {type: 'em'})))],
    ['underscore italic', '_i_', doc(p(t('i', {type: 'em'})))],
    ['strikethrough', '~~s~~', doc(p(t('s', {type: 'strikethrough'})))],
    ['inline code', 'run `npm ci`', doc(p(t('run '), t('npm ci', {type: 'code'})))],
    ['a link', '[site](https://example.com/a)', doc(p(t('site', {type: 'link', attrs: {href: 'https://example.com/a'}})))],
    ['a reference link', '[site][1]\n\n[1]: https://example.com/r', doc(p(t('site', {type: 'link', attrs: {href: 'https://example.com/r'}})))],
    ['a mailto link', '[me](mailto:a@example.com)', doc(p(t('me', {type: 'link', attrs: {href: 'mailto:a@example.com'}})))],
    ['nested marks combining', '**bold [link](https://example.com)**', doc(p(
      t('bold ', {type: 'strong'}),
      t('link', {type: 'strong'}, {type: 'link', attrs: {href: 'https://example.com'}}),
    ))],
    ['bold italic', '***x***', doc(p(t('x', {type: 'em'}, {type: 'strong'})))],
    ['an escaped character merged into its run', 'a \\*b\\* c', doc(p(t('a *b* c')))],
    ['entities decoded', 'Q&amp;A &lt;3 &#169; &#x2014;', doc(p(t('Q&A <3 © —')))],
    ['an unknown entity left literal', '&bogus;', doc(p(t('&bogus;')))],
    ['a bullet list', '- a\n- b', doc({type: 'bullet_list', content: [li(p(t('a'))), li(p(t('b')))]})],
    ['a loose bullet list', '- a\n\n- b', doc({type: 'bullet_list', content: [li(p(t('a'))), li(p(t('b')))]})],
    ['an ordered list from 1, with no attrs', '1. a\n2. b', doc({type: 'ordered_list', content: [li(p(t('a'))), li(p(t('b')))]})],
    ['an ordered list from 3, numbered by order', '3. a\n4. b', doc({type: 'ordered_list', attrs: {order: 3}, content: [li(p(t('a'))), li(p(t('b')))]})],
    ['a nested list', '- a\n  - b', doc({type: 'bullet_list', content: [
      li(p(t('a')), {type: 'bullet_list', content: [li(p(t('b')))]}),
    ]})],
    ['marks inside a list item', '- **a**', doc({type: 'bullet_list', content: [li(p(t('a', {type: 'strong'})))]})],
    ['a blockquote', '> quoted', doc({type: 'blockquote', content: [p(t('quoted'))]})],
    ['a list inside a blockquote', '> - a', doc({type: 'blockquote', content: [{type: 'bullet_list', content: [li(p(t('a')))]}]})],
    ['a fenced code block with a language', '```JS\nconst a = 1;\nconst b = 2;\n```', doc({
      type: 'highlighted_code_block', attrs: {language: 'js'}, content: [t('const a = 1;\nconst b = 2;')],
    })],
    ['a fenced code block with a longer info string', '```python title="x"\npass\n```', doc({
      type: 'highlighted_code_block', attrs: {language: 'python'}, content: [t('pass')],
    })],
    ['a fenced code block without a language', '```\nraw <b>\n```', doc({type: 'highlighted_code_block', content: [t('raw <b>')]})],
    ['an indented code block', '    indented', doc({type: 'highlighted_code_block', content: [t('indented')]})],
    ['an empty code block', '```\n```', doc({type: 'highlighted_code_block', content: []})],
    ['a divider', 'a\n\n---\n\nb', doc(p(t('a')), {type: 'horizontal_rule'}, p(t('b')))],
    ['a Substack-hosted image', `![A board](${IMG})`, doc({type: 'captionedImage', content: [
      {type: 'image2', attrs: {src: IMG, alt: 'A board'}},
    ]})],
    ['an image without alt text', `![](${IMG})`, doc({type: 'captionedImage', content: [
      {type: 'image2', attrs: {src: IMG, alt: null}},
    ]})],
    ['a CDN image whose title is not promoted to a caption', '![x](https://substackcdn.com/image/fetch/a.png "tip")', doc({
      type: 'captionedImage', content: [{type: 'image2', attrs: {src: 'https://substackcdn.com/image/fetch/a.png', alt: 'x'}}],
    })],
  ];

  for (const [name, markdown, expected] of cases) {
    test(name, () => {
      assert.deepEqual(markdownToDoc(markdown), expected);
    });
  }

  test('every converted document passes the schema set_post_body publishes', () => {
    for (const [, markdown] of cases) {
      assert.doesNotThrow(() => postBodySchema.parse(markdownToDoc(markdown)), markdown);
    }
  });

  test('a whole post converts in document order', () => {
    const markdown = [
      '# Launch notes', '', 'Intro with **bold**.', '', '## Steps', '', '1. Install', '2. Run', '',
      '> Ship it.', '', '```bash', 'npm ci', '```', '', `![Diagram](${IMG})`, '', '---', '', 'Bye.',
    ].join('\n');

    assert.deepEqual(markdownToDoc(markdown).content.map((node) => node.type), [
      'heading', 'paragraph', 'heading', 'ordered_list', 'blockquote',
      'highlighted_code_block', 'captionedImage', 'horizontal_rule', 'paragraph',
    ]);
  });
});

describe('markdownToDoc — what is refused rather than degraded', () => {
  const refuse = (markdown) => {
    try {
      markdownToDoc(markdown);
    } catch (error) {
      assert.ok(error instanceof MarkdownConversionError, `expected MarkdownConversionError, got ${error}`);
      return error;
    }
    assert.fail(`expected ${JSON.stringify(markdown)} to be refused`);
  };

  const cases = [
    ['a table', '| a |\n|---|\n| b |', /table/],
    ['block HTML', '<div>hi</div>', /HTML/],
    ['an HTML comment', '<!-- paywall -->', /HTML/],
    ['inline HTML', 'a <span>b</span>', /inline HTML/],
    ['a task list', '- [ ] todo', /task list/],
    ['a relative link', '[x](/about)', /relative URL/],
    // The degradation measured against the first Markdown design: a button rewritten as a link.
    ['a link to the checkout placeholder', '[Subscribe](%%checkout_url%%)', /button/],
    ['a link to the share placeholder', '[Share](%%share_url%%)', /button/],
    ['an external image', '![x](https://example.com/a.png)', /upload_image/],
    ['a lookalike image host', '![x](https://substackcdn.com.evil.example/a.png)', /upload_image/],
    ['an image inside a line', `see ![x](${IMG}) here`, /paragraph of its own/],
    ['an image in a list', `- ![x](${IMG})`, /paragraph of its own/],
    ['an image in a quote', `> ![x](${IMG})`, /inside a quote/],
    ['a heading in a quote', '> # h', /inside a quote/],
    ['code in a quote', '> ```\n> x\n> ```', /inside a quote/],
    ['a nested quote', '> > deep', /inside a quote/],
    ['code in a list item', '- a\n\n  ```\n  x\n  ```', /inside a list item/],
  ];

  for (const [name, markdown, pattern] of cases) {
    test(name, () => {
      assert.match(refuse(markdown).message, pattern);
    });
  }

  test('names every problem, not just the first', () => {
    const error = refuse('| a |\n|---|\n| b |\n\n<div>x</div>\n\n![x](https://example.com/a.png)');

    assert.equal(error.problems.length, 3);
    assert.match(error.message, /nothing was written/);
    assert.match(error.message, /set_post_body/);
  });

  test('refuses the whole document when only part of it is unconvertible', () => {
    assert.throws(() => markdownToDoc('# Fine\n\nFine too.\n\n| bad |\n|---|\n| x |'), MarkdownConversionError);
  });
});
