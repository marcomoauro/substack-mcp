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

export const postBodySchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(z.discriminatedUnion('type', [paragraphNode, headingNode])),
}).describe('The post body as a Substack ProseMirror document.');
