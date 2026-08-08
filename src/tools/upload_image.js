import {z} from "zod";
import dns from "node:dns";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Caps what we hold and re-encode: an oversized body is still buffered once by fetch, but we
// reject it before the ~1.37x base64 copy and the upload. NOT Substack's own limit (its
// MAX_FILE_SIZE could not be read from the minified bundle).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

// strictObject: an unknown key is reported, never stripped — the only repair signal an LLM gets.
export const uploadImageSchema = z.strictObject({
  url: z
    .string()
    .url()
    .describe(
      "The http(s) URL of an image to upload. The server downloads it and re-hosts it on Substack. " +
        "Private, loopback and link-local hosts are refused. Max 10 MB. HEIC is not accepted."
    ),
  post_id: z
    .number()
    .optional()
    .describe("Optional id of the post the image belongs to. Its effect is unconfirmed."),
});

// Resolve every address a host maps to. Injected in tests so DNS is never touched.
const defaultLookup = (hostname) => dns.promises.lookup(hostname, {all: true});

// Loopback / private / link-local / unique-local / unspecified, plus IPv4-mapped IPv6.
export function isPrivateAddress(address, family) {
  if (family === 4) {
    const p = address.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. 169.254.169.254
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const a = address.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) is unwrapped; other embeddings (6to4/Teredo/NAT64) are not —
  // accepted residual risk.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1], 4);
  return false;
}

async function assertPublicUrl(rawUrl, lookup) {
  // The schema's .url() already guaranteed this parses.
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`upload_image: only http and https URLs are allowed, got ${url.protocol}`);
  }
  const addresses = await lookup(url.hostname);
  for (const {address, family} of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new Error(`upload_image: refusing to fetch a private/loopback address (${address})`);
    }
  }
  return url;
}

// `fetch`'s default `redirect: 'follow'` would contact a redirect target before we ever see its
// host, which turns `assertPublicUrl` into a check on the ORIGINAL host only — a public host that
// 3xx-redirects to http://169.254.169.254/ (or any private address) bypasses the guard entirely.
// So redirects are followed manually here, validating each hop's host before it is contacted.
async function fetchGuarded(rawUrl, lookup, fetchImpl, maxRedirects = 3) {
  let target = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(target, lookup); // validate before every request, including each redirect
    const response = await fetchImpl(target, {redirect: 'manual'});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`upload_image: redirect with no Location header from ${target}`);
      target = new URL(location, target).toString(); // resolve relative redirects against current URL
      continue;
    }
    return response;
  }
  throw new Error(`upload_image: too many redirects (> ${maxRedirects})`);
}

export const uploadImageHandler = async (args, {lookup = defaultLookup, fetchImpl = fetch} = {}) => {
  logger.debug('upload_image.start', {args});

  let validatedArgs;
  try {
    validatedArgs = uploadImageSchema.parse(args);
  } catch (error) {
    logger.error('upload_image.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }
  const {url, post_id} = validatedArgs;

  logger.info('upload_image.fetching', {url, post_id: post_id ?? null});
  const response = await fetchGuarded(url, lookup, fetchImpl);
  if (!response.ok) {
    throw new Error(`upload_image: source responded ${response.status} ${response.statusText}`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`upload_image: source is not an image (content-type: ${contentType || 'none'})`);
  }
  if (HEIC_TYPES.has(contentType)) {
    throw new Error('upload_image: HEIC is not accepted by Substack. Convert to JPG or PNG first.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `upload_image: image is ${buffer.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte limit.`
    );
  }

  const image = `data:${contentType};base64,${buffer.toString('base64')}`;
  // The data URI is deliberately NOT logged: hundreds of KB of base64 would bury the session. This
  // is the one exception to "post content is not truncated".
  logger.info('upload_image.uploading', {content_type: contentType, bytes: buffer.byteLength, post_id: post_id ?? null});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });
  const uploaded = await substack_api.uploadImage({image, post_id: post_id ?? null});

  logger.info('upload_image.done', {url: uploaded.url, bytes: uploaded.bytes});

  return {
    id: uploaded.id,
    url: uploaded.url,
    content_type: uploaded.contentType,
    bytes: uploaded.bytes,
    width: uploaded.imageWidth,
    height: uploaded.imageHeight,
  };
};
