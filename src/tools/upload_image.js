import {z} from "zod";
import dns from "node:dns";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";

// Our own memory guard, NOT Substack's limit (its MAX_FILE_SIZE could not be read from the minified
// bundle). The downloaded buffer plus its ~1.37x base64 string sit in RAM; 10 MB caps that.
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
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateAddress(mapped[1], 4);
  return false;
}

async function assertPublicUrl(rawUrl, lookup) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`upload_image: not a valid URL: ${rawUrl}`);
  }
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

export const uploadImageHandler = async (args, {lookup = defaultLookup, fetchImpl = fetch} = {}) => {
  const {url, post_id} = uploadImageSchema.parse(args);

  await assertPublicUrl(url, lookup);

  logger.info('upload_image.fetching', {url, post_id: post_id ?? null});
  const response = await fetchImpl(url);
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
