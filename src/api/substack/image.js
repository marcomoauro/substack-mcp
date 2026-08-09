import dns from "node:dns";
import fsp from "node:fs/promises";
import nodePath from "node:path";

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

// One string, so the URL path and the local-file path give the caller the identical instruction.
const HEIC_MESSAGE = 'image: HEIC is not accepted by Substack. Convert to JPG or PNG first.';

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

// Measured live 2026-08-08: `POST /api/v1/image` answers a url on the S3 bucket, and a cover read
// back from `list_posts`/`get_draft` arrives rewritten onto the CDN. Anything else has to be
// re-hosted, because Substack server-fetches only its own bucket — an external url passed as
// `image` answers `400 "Failed to fetch image"`.
export const SUBSTACK_IMAGE_HOSTS = new Set([
  'substack-post-media.s3.amazonaws.com',
  'substackcdn.com',
]);

/**
 * Whether a url is already hosted by Substack and can be written to `cover_image` as-is.
 *
 * Exact hostname match, never a substring: `substackcdn.com.evil.example` contains the host and is
 * not it. Returns false rather than throwing on unparseable input — `cover_image` accepts any
 * string server-side (`"not-a-url-at-all"` was stored with a 200), so the caller owns that message.
 */
export function isSubstackHosted(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SUBSTACK_IMAGE_HOSTS.has(hostname);
}

// The one encoding `POST /api/v1/image` accepts, shared by both sources so they cannot drift.
const toDataUri = (buffer, contentType) => `data:${contentType};base64,${buffer.toString('base64')}`;

// ISO-BMFF brands that mean HEIC/HEIF. `mif1`/`msf1` are the generic image and image-sequence
// brands Apple also writes; all of them are refused with the same convert-first message.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * The content type of a local file, read off its magic bytes rather than its extension.
 *
 * A local file arrives with no Content-Type header, and the extension is the caller's claim, not
 * evidence: a PDF renamed to `.png` would reach `POST /api/v1/image` and come back as a 400 that
 * names neither the file nor the reason. Five bounded signatures, written out rather than taken as
 * a dependency — the same argument `csv.js` makes about not needing a parser library.
 *
 * Returns null for anything unrecognised, so the caller owns the message.
 */
function sniffImageType(buffer) {
  const at = (start, end) => buffer.subarray(start, end).toString('latin1');

  if (buffer.length >= 8 && at(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && (at(0, 6) === 'GIF87a' || at(0, 6) === 'GIF89a')) return 'image/gif';
  // The four bytes at offset 4 are the RIFF chunk size, part of the container rather than the tag.
  if (buffer.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && at(4, 8) === 'ftyp' && HEIC_BRANDS.has(at(8, 12))) return 'image/heic';
  return null;
}

/**
 * Read a local file and encode it the way `POST /api/v1/image` wants it: a data URI.
 *
 * The sibling of `fetchImageAsDataUri` for a path instead of a URL, and it lives here for the same
 * reason that one does — `upload_image` is the only caller today, but a second copy of these checks
 * would be a second place to get them wrong.
 *
 * The path must be **absolute**: a relative one resolves against this server process's cwd, which
 * is not the calling client's, so it would read the wrong file or none, and neither failure would
 * say why. It is resolved with `realpath` first, so a symlink is followed to the file actually read
 * and `..` cannot mean something different at the check than at the read.
 *
 * Returns `{image, contentType, bytes}`. `image` is deliberately not logged by this module.
 */
export async function readImageFileAsDataUri(filePath, {maxBytes = MAX_IMAGE_BYTES} = {}) {
  if (!nodePath.isAbsolute(filePath)) {
    throw new Error(`image: path must be absolute, got ${JSON.stringify(filePath)}`);
  }

  let resolved;
  try {
    resolved = await fsp.realpath(filePath);
  } catch (error) {
    // Raw, this surfaces as an ENOENT stack from deep in fs — useless to a model trying to repair
    // its own call. The path it passed is the whole diagnosis.
    if (error.code === 'ENOENT') throw new Error(`image: no such file: ${filePath}`);
    throw error;
  }

  const stats = await fsp.stat(resolved);
  if (!stats.isFile()) throw new Error(`image: not a regular file: ${filePath}`);
  // Refused on the size the filesystem reports, before the bytes are read — the local mirror of the
  // Content-Length pre-check in `readCapped`. Only that half is mirrored, and deliberately:
  // `readCapped` re-checks the buffered length afterwards because Content-Length is a claim made by
  // an untrusted remote server, which may declare a small length and send more. `stat.size` is the
  // kernel's own answer about the file `realpath` just resolved, so there is no second party to
  // disagree with. What remains is the window between this `stat` and the `readFile` below — a file
  // that grows in between is read whole. Accepted residual, on the same terms as the DNS-rebinding
  // note above: closing it would mean reading through a bounded stream, and the adversary it would
  // buy protection from already has write access to this machine's disk.
  if (stats.size > maxBytes) {
    throw new Error(`image: file is ${stats.size} bytes, over the ${maxBytes}-byte limit.`);
  }

  const buffer = await fsp.readFile(resolved);
  const contentType = sniffImageType(buffer);
  if (!contentType) {
    const head = [...buffer.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    throw new Error(
      `image: unrecognised image format (first bytes: ${head}). Supported: PNG, JPEG, GIF, WebP.`
    );
  }
  if (HEIC_TYPES.has(contentType)) throw new Error(HEIC_MESSAGE);

  return {image: toDataUri(buffer, contentType), contentType, bytes: buffer.byteLength};
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
  if (HEIC_TYPES.has(contentType)) throw new Error(HEIC_MESSAGE);

  const buffer = await readCapped(response, maxBytes);

  return {image: toDataUri(buffer, contentType), contentType, bytes: buffer.byteLength};
}
