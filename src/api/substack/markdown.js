import {Lexer} from "marked";
import {postBodySchema} from "./document.js";
import {isSubstackHosted} from "./image.js";

// Markdown to the Substack document `set_post_body` stores — for the subset of a post that Markdown
// can actually express.
//
// The idea of accepting Markdown for a draft body comes from nanameru/substack-mcp, whose
// `content_markdown` parameter does it through `python-substack`'s `Post.from_markdown`. No code is
// taken from either: this is written against `postBodySchema` in `document.js`, so every node it
// emits is one that was read off the live editor, and `python-substack`'s `codeBlock` (which
// Substack does not render) cannot leak in.
//
// One rule governs everything below: **convert faithfully or refuse.** The Markdown contract was
// set aside once (docs/superpowers/specs/2026-08-07-markdown-body-design.md) because a model asked
// for a paywall and a button through Markdown degraded the button into a link, dropped the paywall,
// and the `unsupported` list built to catch that came back empty. A list of warnings is a channel a
// model can ignore; an error is not. So nothing here is dropped or approximated: a construct with no
// faithful node — a table, raw HTML, an image in a list, an image not hosted by Substack, a link
// standing in for a Substack button — fails the whole conversion with every problem named, and
// nothing is written. The paywall cannot be detected that way, because its absence is valid
// Markdown; that is what the `nodes` tally in the tool's result is for.
//
// The lexer is `marked`'s, and only the lexer: its renderer and its HTML never run, so no HTML is
// produced or parsed here. Tokens are mapped by hand to nodes, which keeps the mapping readable as
// a table and keeps every refusal explicit.

/** Thrown when Markdown holds something with no faithful Substack node. Carries every problem found. */
export class MarkdownConversionError extends Error {
  constructor(problems) {
    super(
      `This Markdown cannot be converted without losing content, so nothing was written:\n` +
      problems.map((problem) => `- ${problem}`).join('\n') +
      `\nUse set_post_body with a structured document for these.`
    );
    this.name = 'MarkdownConversionError';
    this.problems = problems;
  }
}

// CommonMark decodes entity references in text; marked's lexer leaves them for its renderer, which
// never runs here. The named set is the handful an author actually types — a full table is 2,000+
// names for no measured need, so anything else is left literal, which is what a reader would see
// typed anyway.
const NAMED_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};

const decodeEntities = (text) => text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return NAMED_ENTITIES[name.toLowerCase()] ?? match;
});

// The placeholders the `button` node resolves (`%%checkout_url%%`, `%%share_url%%`). A link to one is
// the exact degradation that sank the first Markdown design: it renders as a plain link, not a
// button, and nothing downstream can tell.
const SUBSTACK_PLACEHOLDER = /^%%[a-z_]+%%$/i;

const isAbsoluteUrl = (href) => {
  try {
    new URL(href);
    return true;
  } catch {
    return false;
  }
};

const sameMarks = (a = [], b = []) => JSON.stringify(a) === JSON.stringify(b);

// Adjacent runs with identical marks are merged so `a\*b` is one text node, not three.
const pushText = (out, text, marks) => {
  if (text === '') return;
  const last = out.at(-1);

  if (last?.type === 'text' && sameMarks(last.marks, marks)) {
    last.text += text;
    return;
  }

  out.push(marks.length > 0 ? {type: 'text', text, marks: [...marks]} : {type: 'text', text});
};

/**
 * Converts Markdown to a Substack document.
 *
 * @param {string} markdown
 * @returns {object} a document that passes `postBodySchema`
 * @throws {MarkdownConversionError} when any part of the input has no faithful node
 */
export function markdownToDoc(markdown) {
  const problems = [];
  const tokens = new Lexer({gfm: true}).lex(markdown);

  const snippet = (token) => JSON.stringify((token.raw ?? '').trim().slice(0, 40));

  // Marks are passed down, so `**[a](u)**` becomes one text node carrying both strong and link.
  const inline = (inlineTokens = [], marks = [], out = []) => {
    for (const token of inlineTokens) {
      switch (token.type) {
        case 'text':
          // A text token inside a tight list item carries its own inline tokens.
          if (token.tokens) {
            inline(token.tokens, marks, out);
          } else {
            // A soft line break is a space in CommonMark; only `br` is a hard break.
            pushText(out, decodeEntities(token.text).replace(/\n/g, ' '), marks);
          }
          break;
        case 'escape':
          pushText(out, token.text, marks);
          break;
        case 'strong':
          inline(token.tokens, [...marks, {type: 'strong'}], out);
          break;
        case 'em':
          inline(token.tokens, [...marks, {type: 'em'}], out);
          break;
        case 'del':
          inline(token.tokens, [...marks, {type: 'strikethrough'}], out);
          break;
        case 'codespan':
          pushText(out, decodeEntities(token.text), [...marks, {type: 'code'}]);
          break;
        case 'br':
          out.push({type: 'hard_break'});
          break;
        case 'link': {
          const href = token.href;

          if (SUBSTACK_PLACEHOLDER.test(href)) {
            problems.push(`link ${snippet(token)} points at ${href}, which only a button node resolves — a link to it is not a button`);
          } else if (!isAbsoluteUrl(href)) {
            problems.push(`link ${snippet(token)} has a relative URL; Substack needs an absolute one`);
          } else {
            inline(token.tokens, [...marks, {type: 'link', attrs: {href}}], out);
          }
          break;
        }
        case 'image':
          problems.push(`image ${snippet(token)} is inside a line of text; put it in a paragraph of its own`);
          break;
        case 'html':
          problems.push(`inline HTML ${snippet(token)} has no Substack equivalent`);
          break;
        default:
          problems.push(`inline ${token.type} ${snippet(token)} has no Substack equivalent`);
      }
    }
    return out;
  };

  const paragraph = (inlineTokens) => {
    const content = inline(inlineTokens);
    return content.length > 0 ? {type: 'paragraph', content} : {type: 'paragraph'};
  };

  // A paragraph holding exactly one image, and nothing but whitespace beside it, is the Markdown
  // spelling of a block image.
  const soleImage = (token) => {
    const meaningful = (token.tokens ?? []).filter((t) => !(t.type === 'text' && t.text.trim() === ''));
    return meaningful.length === 1 && meaningful[0].type === 'image' ? meaningful[0] : null;
  };

  const image = (token) => {
    if (!isSubstackHosted(token.href)) {
      problems.push(`image ${snippet(token)} is not hosted by Substack and would not render; re-host it with upload_image and use the url it returns`);
      return null;
    }
    // The title is not a caption — CommonMark renders it as a tooltip — so it is not promoted to one.
    return {type: 'captionedImage', content: [{type: 'image2', attrs: {src: token.href, alt: token.text || null}}]};
  };

  const list = (token) => {
    const items = token.items.map((item) => {
      if (item.task) {
        problems.push(`task list item ${snippet(item)} has no Substack equivalent`);
        return null;
      }

      const content = [];

      for (const child of item.tokens) {
        if (child.type === 'text' || child.type === 'paragraph') {
          content.push(paragraph(child.tokens ?? [child]));
        } else if (child.type === 'list') {
          content.push(list(child));
        } else if (child.type !== 'space') {
          problems.push(`${child.type} ${snippet(child)} inside a list item; a Substack list item holds only text and nested lists`);
        }
      }

      return {type: 'list_item', content};
    }).filter(Boolean);

    if (!token.ordered) return {type: 'bullet_list', content: items};

    // `order`, not `start`: it is the attr that renders (see orderedListNode in document.js).
    const start = Number(token.start);
    return Number.isInteger(start) && start !== 1
      ? {type: 'ordered_list', attrs: {order: start}, content: items}
      : {type: 'ordered_list', content: items};
  };

  const block = (token, {inBlockquote = false} = {}) => {
    switch (token.type) {
      case 'space':
      case 'def':
        // `def` is a link reference definition; marked has already resolved every reference to it.
        return null;
      case 'paragraph': {
        const img = soleImage(token);
        if (img) {
          if (inBlockquote) {
            problems.push(`image ${snippet(img)} inside a quote; a Substack quote holds only paragraphs and lists`);
            return null;
          }
          return image(img);
        }
        return paragraph(token.tokens);
      }
      case 'text':
        return paragraph(token.tokens ?? [token]);
      case 'list':
        return list(token);
      case 'heading':
        if (inBlockquote) break;
        return {type: 'heading', attrs: {level: token.depth}, ...contentOf(inline(token.tokens))};
      case 'blockquote':
        if (inBlockquote) break;
        return {
          type: 'blockquote',
          content: token.tokens.map((child) => block(child, {inBlockquote: true})).filter(Boolean),
        };
      case 'code': {
        if (inBlockquote) break;
        if (token.codeBlockStyle !== 'indented' && token.lang) {
          // The first word of the info string, lowercased: highlight.js names are lowercase.
          const language = token.lang.trim().split(/\s+/)[0].toLowerCase();
          return {type: 'highlighted_code_block', attrs: {language}, ...codeContent(token.text)};
        }
        return {type: 'highlighted_code_block', ...codeContent(token.text)};
      }
      case 'hr':
        if (inBlockquote) break;
        return {type: 'horizontal_rule'};
      case 'html':
        problems.push(`HTML ${snippet(token)} has no Substack equivalent`);
        return null;
      case 'table':
        problems.push(`table ${snippet(token)} has no Substack equivalent`);
        return null;
      default:
        problems.push(`${token.type} ${snippet(token)} has no Substack equivalent`);
        return null;
    }

    problems.push(`${token.type} ${snippet(token)} inside a quote; a Substack quote holds only paragraphs and lists`);
    return null;
  };

  const contentOf = (content) => (content.length > 0 ? {content} : {});
  // The schema requires content on a code block; an empty one gets an empty array rather than an
  // empty text node, which ProseMirror would reject.
  const codeContent = (text) => ({content: text === '' ? [] : [{type: 'text', text}]});

  const doc = {type: 'doc', content: tokens.map((token) => block(token)).filter(Boolean)};

  if (problems.length > 0) throw new MarkdownConversionError(problems);

  // Belt and braces: everything above is written to emit schema-valid nodes, and this proves it on
  // every call rather than trusting it. A failure here is a bug in this file, not in the input.
  return postBodySchema.parse(doc);
}
