import {z} from "zod";

// The Substack post body, as a ProseMirror document.
//
// Every node name and attr shape here was read off a live draft or a live published post on
// 2026-08-07, never taken from a third-party client — `python-substack` declares the code block as
// `codeBlock`, which Substack does not render. See the design spec for the survey behind the
// enumeration: 60 published posts, every node type in use counted.
//
// Two rules govern how strict this is, and they pull in opposite directions on purpose:
//
//  - `type` is strict. It is a discriminated union so an unrecognised node is rejected with the
//    valid alternatives named, which is the only feedback an LLM gets to repair the call.
//  - `attrs` are loose. The editor writes `textAlign: null` on paragraphs and headings and
//    `nodeId: null` on code blocks; rejecting those would reject every real post and kill any
//    read-modify-write flow. Required attrs still guard, so a heading without `level` fails.

const looseAttrs = z.looseObject({}).describe('Editor-written attributes; pass them back unchanged.');

const markSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('strong')}).describe('Bold.'),
  z.strictObject({type: z.literal('em')}).describe('Italic.'),
  z.strictObject({type: z.literal('code')}).describe('Inline code, for a short literal inside a sentence.'),
  z.strictObject({type: z.literal('strikethrough')}).describe('Struck through.'),
  z.strictObject({
    type: z.literal('link'),
    attrs: z.looseObject({href: z.string().describe('Absolute URL.')}),
  }).describe('A link. The visible words are the text node this mark is applied to.'),
]).describe('An inline mark applied to a text node. A mark is never a node in its own right.');

const textNode = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(markSchema).optional().describe('Omit when the text is plain. Marks may combine.'),
}).describe('A run of text. Split a sentence into several text nodes to mark only part of it.');

const hardBreakNode = z.strictObject({type: z.literal('hard_break')})
  .describe('A line break inside a paragraph. Prefer separate paragraphs.');

const inlineContent = z.array(z.discriminatedUnion('type', [textNode, hardBreakNode]));

const paragraphNode = z.strictObject({
  type: z.literal('paragraph'),
  attrs: looseAttrs.optional(),
  content: inlineContent.optional().describe('Omit for an empty paragraph.'),
}).describe('A paragraph of text — the most common node in the document.');

const headingAttrs = looseAttrs.extend({
  level: z.number().int().min(1).max(6).describe('Heading level, 1 (largest) to 6 (smallest).'),
}).describe('Editor-written attributes; pass them back unchanged.');

// content is optional, matching paragraphNode, rather than required as ProseMirror would allow:
// zero empty headings turned up across the 12 real published posts sampled for this design, so the
// evidence for either choice is weak, but the consequence is not. Rejecting a real document breaks
// the read-modify-write round trip this contract exists to protect; accepting a contentless heading
// is at worst a cosmetic authoring mistake. Do not tighten this back to required without
// remeasuring against a larger sample.
const headingNode = z.strictObject({
  type: z.literal('heading'),
  attrs: headingAttrs,
  content: inlineContent.optional().describe('Omit for an empty heading.'),
}).describe('A section heading, levels 1 to 6.');

// Recursion through getters, which is how zod 4 expresses it. The unions here stay discriminated
// even though a plain `z.union` would be less awkward: a plain one reports no usable message, which
// was measured rather than assumed — a malformed node came back as "this is a modelled node, match
// its shape" with no mention of which field was wrong.
const listItemNode = z.strictObject({
  type: z.literal('list_item'),
  get content() {
    return z.array(z.discriminatedUnion('type', [paragraphNode, bulletListNode, orderedListNode]))
      .describe('A paragraph, plus a nested list for sub-items.');
  },
}).describe('One item of a list. Its text goes in a paragraph, never directly in the item.');

const bulletListNode = z.strictObject({
  type: z.literal('bullet_list'),
  attrs: looseAttrs.optional(),
  get content() { return z.array(listItemNode); },
}).describe('A bulleted list.');

const orderedListNode = z.strictObject({
  type: z.literal('ordered_list'),
  attrs: looseAttrs.extend({start: z.number().int().optional()}).optional()
    .describe('Omit unless the list starts somewhere other than 1.'),
  get content() { return z.array(listItemNode); },
}).describe('A numbered list.');

const blockquoteNode = z.strictObject({
  type: z.literal('blockquote'),
  get content() { return z.array(z.discriminatedUnion('type', [paragraphNode, bulletListNode, orderedListNode])); },
}).describe('A quotation. Holds paragraphs and lists, not bare text.');

// `highlighted_code_block`, not `codeBlock`: read off the live editor. `python-substack` declares
// the latter, and a node by that name is not rendered.
const codeBlockNode = z.strictObject({
  type: z.literal('highlighted_code_block'),
  attrs: looseAttrs.extend({
    language: z.string().optional().describe(
      'Lowercase highlight.js name — javascript, typescript, python, bash, json, sql, go, rust, ' +
      'yaml, css, html and similar. Omit to let Substack auto-detect. An unrecognised value is ' +
      'accepted and then silently rendered as plain text, so omitting beats guessing.'
    ),
  }).optional(),
  content: inlineContent.describe('One text node holding the whole snippet, newlines included.'),
}).describe('A syntax-highlighted code block.');

const legacyCodeBlockNode = z.strictObject({
  type: z.literal('code_block'),
  attrs: looseAttrs.optional(),
  content: inlineContent,
}).describe('The older code block, still present in existing posts. Use highlighted_code_block for new content.');

const horizontalRuleNode = z.strictObject({type: z.literal('horizontal_rule')})
  .describe('A horizontal divider.');

const paywallNode = z.strictObject({type: z.literal('paywall')})
  .describe('Everything after this node is for paying subscribers only. At most one per document.');

const captionedImageNode = z.strictObject({
  type: z.literal('captionedImage'),
  content: z.array(z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('image2'),
      attrs: looseAttrs.extend({
        src: z.string().describe('Image URL. It must already be hosted by Substack — an external url is stored but does not render.'),
        alt: z.string().nullable().optional(),
      }),
    }).describe('The image itself. Only valid inside a captionedImage.'),
    z.strictObject({
      type: z.literal('caption'),
      content: inlineContent.optional(),
    }).describe('The caption under an image. Only valid inside a captionedImage.'),
  ])),
}).describe('An image, optionally followed by a caption node.');

const buttonNode = z.strictObject({
  type: z.literal('button'),
  attrs: looseAttrs.extend({
    url: z.string().describe('Target, or a Substack placeholder: %%checkout_url%% to subscribe, %%share_url%% to share.'),
    text: z.string().describe('The button label.'),
  }),
}).describe('A call-to-action button.');

// Verified 2026-08-07 on the quickviewai publication, where it appears in 33 of 40 sampled posts:
// exactly `{videoId}` and no content, identical in every occurrence. `SubstackPost.youtubeVideo()`
// already builds this shape, so on this one node the existing builder was right.
const youtubeNode = z.strictObject({
  type: z.literal('youtube2'),
  attrs: looseAttrs.extend({videoId: z.string().describe('The YouTube video id, not the watch URL.')}),
}).describe('An embedded YouTube video.');

// A node whose internals were never read. `looseObject` keeps everything it carries — including its
// content — so a round trip preserves it exactly, while claiming no knowledge we do not have.
const opaqueNode = (type, description) =>
  z.looseObject({type: z.literal(type)}).describe(description);

// Present in the live archive, internals never read. digestPostEmbed alone is in 59 of 60 sampled
// posts, so these three are what make a read-modify-write round trip possible at all.
const digestPostEmbedNode = opaqueNode('digestPostEmbed', 'An embedded post card. Substack inserts this itself; pass it back unchanged.');
const substackMentionsNode = opaqueNode('substack_mentions', 'A mention of another publication or user.');
const directMessageNode = opaqueNode('directMessage', 'A direct-message block.');

export const postBodySchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(z.discriminatedUnion('type', [
    paragraphNode, headingNode, bulletListNode, orderedListNode, blockquoteNode,
    codeBlockNode, legacyCodeBlockNode, horizontalRuleNode, paywallNode,
    captionedImageNode, buttonNode, youtubeNode,
    digestPostEmbedNode, substackMentionsNode, directMessageNode,
  ])),
})
  .describe('The post body as a Substack ProseMirror document.')
  // A refinement does not survive into the published JSON Schema — verified — which is why the rule
  // is also written into paywallNode's description. Without that a model would meet it by failing.
  .refine(
    (document) => document.content.filter((node) => node.type === 'paywall').length <= 1,
    {message: 'A document may contain at most one paywall node.', path: ['content']}
  );
