import dns from "node:dns";

// Checked against a declared Content-Length before the body is read, then against the buffered
// length. NOT Substack's own limit (its MAX_FILE_SIZE could not be read from the minified bundle).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// A caller-chosen host is untrusted: without a deadline a slow or stalled response hangs the tool
// call indefinitely. Each request (and each redirect hop) gets its own.
const FETCH_TIMEOUT_MS = 20000;

// heic/heif plus the `-sequence` variants some Apple devices send for burst and live photos: all
// four start with `image/`, so without this they would pass the image check and fail later at
// Substack instead of getting the friendlier convert-first message.
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

// Resolve every address a host maps to. Injected in tests so DNS is never touched.
export const defaultLookup = (hostname) => dns.promises.lookup(hostname, {all: true});

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
  // IPv4-mapped IPv6 is unwrapped and re-checked as v4; other embeddings (6to4/Teredo/NAT64) are
  // not — accepted residual risk.
  const mapped = embeddedIpv4(a);
  if (mapped) return isPrivateAddress(mapped, 4);
  return false;
}

// The trailing IPv4 of an IPv4-mapped IPv6 address, in either the dotted form (`::ffff:1.2.3.4`) or
// the compressed hex form (`::ffff:102:304`) the WHATWG URL parser emits — the latter is why the
// dotted-only regex was an SSRF hole: `http://[::ffff:169.254.169.254]/` reaches this as
// `::ffff:a9fe:a9fe`, the metadata address wearing a disguise.
function embeddedIpv4(address) {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

async function assertPublicUrl(rawUrl, lookup) {
  // The caller's schema already guaranteed this parses.
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`image: only http and https URLs are allowed, got ${url.protocol}`);
  }
  // An IPv6 host arrives bracket-wrapped (`[::1]`); dns.lookup and the address checks want it bare.
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const addresses = await lookup(hostname);
  for (const {address, family} of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new Error(`image: refusing to fetch a private/loopback address (${address})`);
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
    const response = await fetchImpl(target, {redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`image: redirect with no Location header from ${target}`);
      target = new URL(location, target).toString(); // resolve relative redirects against current URL
      continue;
    }
    return response;
  }
  throw new Error(`image: too many redirects (> ${maxRedirects})`);
}

// Enforces the cap in two places. A declared Content-Length over the limit is refused before the
// body is read at all — the cheap common case. The buffered length is then re-checked, since a
// response may declare a small (or no) length and send more. A response that both omits its length
// AND streams unboundedly is bounded not by the byte cap but by FETCH_TIMEOUT_MS on the request —
// an accepted residual, the same shape of trade-off as the DNS-rebinding note.
async function readCapped(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) {
    throw new Error(`image: source is ${declared} bytes (Content-Length), over the ${max}-byte limit.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > max) {
    throw new Error(`image: source is ${buffer.byteLength} bytes, over the ${max}-byte limit.`);
  }
  return buffer;
}

/**
 * Download a caller-chosen URL and encode it the way `POST /api/v1/image` wants it: a data URI.
 * Every guard lives here so both callers get the same one — there is no unguarded path.
 *
 * Returns `{image, contentType, bytes}`. `image` is deliberately not logged by this module: at
 * hundreds of KB of base64 it would bury a session. `src/logger.js` truncates it if it slips into a
 * payload anyway.
 */
export async function fetchImageAsDataUri(url, {lookup = defaultLookup, fetchImpl = fetch, maxBytes = MAX_IMAGE_BYTES} = {}) {
  const response = await fetchGuarded(url, lookup, fetchImpl);
  if (!response.ok) {
    throw new Error(`image: source responded ${response.status} ${response.statusText}`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`image: source is not an image (content-type: ${contentType || 'none'})`);
  }
  if (HEIC_TYPES.has(contentType)) {
    throw new Error('image: HEIC is not accepted by Substack. Convert to JPG or PNG first.');
  }

  const buffer = await readCapped(response, maxBytes);

  return {
    image: `data:${contentType};base64,${buffer.toString('base64')}`,
    contentType,
    bytes: buffer.byteLength,
  };
}
