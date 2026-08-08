# Draft Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `update_draft` from three fields to the nine settings the Substack draft editor's
Post settings panel exposes, including a `cover_image` that re-hosts an external URL automatically.

**Architecture:** The untrusted-URL image pipeline moves out of `src/tools/upload_image.js` into a
shared `src/api/substack/image.js`, so both `upload_image` and `update_draft` use one guarded
download path. `update_draft` resolves `cover_image` first — pass through if already on a Substack
host, otherwise download and re-upload — then issues a single `PUT /api/v1/drafts/:id` carrying every
provided field.

**Tech Stack:** Node 24 (floor 22), ESM, zod 4, `@modelcontextprotocol/sdk`, `node --test`, MSW.

**Spec:** `docs/superpowers/specs/2026-08-08-draft-settings-design.md`

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/api/substack/image.js` | **Create.** Fetching a caller-chosen URL safely and encoding it as a data URI: SSRF guard, redirect re-validation, size cap, content-type check. Plus `isSubstackHosted`. No `SubstackApi` dependency — callers compose. |
| `src/api/substack/image.spec.js` | **Create.** Tests for `isSubstackHosted`. The fetch pipeline stays covered by `upload_image.spec.js`, which exercises it end to end. |
| `src/tools/upload_image.js` | **Modify.** Becomes schema + handler over the shared module. Re-exports `isPrivateAddress` and `MAX_IMAGE_BYTES` so its spec's imports keep working. |
| `src/tools/update_draft.js` | **Modify.** Eleven-field schema, cover-image resolution, single PUT. |
| `src/tools/update_draft.spec.js` | **Modify.** New field forwarding, `only_free`, pass-through vs re-host, abort-before-PUT. |
| `src/server.js:100-107` | **Modify.** The registry description no longer says "title, subtitle or audience". |
| `README.md:173` | **Modify.** Same. |
| `CLAUDE.md` | **Modify.** The measured facts. |

---

## Task 1: Extract the image pipeline into a shared module

Pure refactor. No behaviour changes, no new tests — the existing suite is the safety net, and it must
stay green at every step.

**Files:**
- Create: `src/api/substack/image.js`
- Modify: `src/tools/upload_image.js`

- [ ] **Step 1: Confirm the suite is green before touching anything**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: a `fail 0` line. Note the `pass` count — it must be identical at the end of this task.

- [ ] **Step 2: Create `src/api/substack/image.js`**

This is `upload_image.js`'s pipeline moved verbatim, with two changes: every error message's
`upload_image:` prefix becomes `image:`, and the pipeline gains `fetchImageAsDataUri` as its single
entry point.

```javascript
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
```

- [ ] **Step 3: Rewrite `src/tools/upload_image.js` as a thin tool over the shared module**

Replace the file's entire contents with this. Behaviour is unchanged: the same guards run, in the
same order, and the same fields come back.

```javascript
import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {fetchImageAsDataUri, defaultLookup, isPrivateAddress, MAX_IMAGE_BYTES} from "../api/substack/image.js";
import {logger} from "../logger.js";

// Re-exported, not redefined: `upload_image.spec.js` imports both from here, and the pipeline they
// belong to now lives in `src/api/substack/image.js` because `update_draft` needs it too.
export {isPrivateAddress, MAX_IMAGE_BYTES};

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
  const {image, contentType, bytes} = await fetchImageAsDataUri(url, {lookup, fetchImpl});

  // The data URI is deliberately NOT logged: hundreds of KB of base64 would bury the session. This
  // is the one exception to "post content is not truncated".
  logger.info('upload_image.uploading', {content_type: contentType, bytes, post_id: post_id ?? null});

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
```

- [ ] **Step 4: Run the suite — the same tests must still pass, with no edits to any spec**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `fail 0`, and the `pass` count identical to Step 1. If `upload_image.spec.js` fails on an
error message, the extraction changed a fragment the spec asserts — the four it asserts are
`/not an image/`, `/HEIC is not accepted/`, `/only http and https/` and `/over the .* limit/`, all of
which survive the prefix change. Fix the module, not the spec.

- [ ] **Step 5: Prove the extraction is actually load-bearing**

A refactor that no test exercises is a refactor you cannot trust. Break the shared module and
confirm the *existing* spec catches it:

```bash
perl -pi -e "s/if \(!contentType\.startsWith\('image\/'\)\)/if (false)/" src/api/substack/image.js
grep -n "if (false)" src/api/substack/image.js
```

Expected: grep prints a line — this confirms the mutation landed. A `perl` regex that fails to match
leaves the file untouched and reads exactly like a passing test.

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: a failure naming the "not an image" test. Now restore:

```bash
git checkout src/api/substack/image.js
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `fail 0` again.

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/image.js src/tools/upload_image.js
git commit -m "Extract the guarded image pipeline into src/api/substack/image.js

update_draft needs the same download-and-encode path for cover_image, and a
second copy of an SSRF guard is a second place to get it wrong. The error
prefix becomes a neutral \`image:\` so update_draft does not report failures
signed by a tool the caller never invoked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `isSubstackHosted`

A cover already on a Substack host is forwarded unchanged. Without this, re-reading a cover from
`get_draft` and writing it back would upload a duplicate of an asset Substack already serves.

**Files:**
- Modify: `src/api/substack/image.js`
- Create: `src/api/substack/image.spec.js`

- [ ] **Step 1: Write the failing test**

Create `src/api/substack/image.spec.js`:

```javascript
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {isSubstackHosted} from './image.js';

// The two hosts measured live on 2026-08-08: `POST /api/v1/image` answers a url on the S3 bucket,
// and `list_posts`/`get_draft` hand back covers already rewritten onto the CDN. Both are already
// hosted by Substack, so both must pass through rather than be re-uploaded.
describe('isSubstackHosted', () => {
  test('accepts the S3 bucket POST /api/v1/image returns', () => {
    assert.equal(
      isSubstackHosted('https://substack-post-media.s3.amazonaws.com/public/images/x_1500x1000.jpeg'),
      true
    );
  });

  test('accepts a substackcdn.com url, the form a cover is read back as', () => {
    assert.equal(
      isSubstackHosted('https://substackcdn.com/image/fetch/$s_!0RI6!,f_auto/https%3A%2F%2Fexample.com%2Fa.png'),
      true
    );
  });

  test('rejects an unrelated host', () => {
    assert.equal(isSubstackHosted('https://upload.wikimedia.org/wikipedia/commons/4/47/a.png'), false);
  });

  // The trap a `String.includes` check walks into: an attacker-controlled host that merely contains
  // the string would pass, and the cover would silently point off Substack.
  test('rejects a host that only contains a Substack host as a substring', () => {
    assert.equal(isSubstackHosted('https://substackcdn.com.evil.example/a.png'), false);
    assert.equal(isSubstackHosted('https://notsubstackcdn.com/a.png'), false);
  });

  // Unparseable input must not throw here: the caller decides what to do with it, and a thrown
  // TypeError from the URL parser would surface as a crash rather than a validation message.
  test('returns false for a string that is not a URL', () => {
    assert.equal(isSubstackHosted('not-a-url-at-all'), false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm test 2>&1 | grep -E "isSubstackHosted|^(not ok|✖)" | head -5
```

Expected: failures — `isSubstackHosted` is not exported yet, so the import is `undefined` and every
call throws `isSubstackHosted is not a function`.

- [ ] **Step 3: Implement the minimal code**

Append to `src/api/substack/image.js`:

```javascript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `fail 0`.

- [ ] **Step 5: Mutate to prove the substring test is not vacuous**

```bash
perl -pi -e "s/return SUBSTACK_IMAGE_HOSTS\.has\(hostname\);/return [...SUBSTACK_IMAGE_HOSTS].some((h) => hostname.includes(h));/" src/api/substack/image.js
grep -n "hostname.includes" src/api/substack/image.js
```

Expected: grep prints the line. Then:

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the "only contains a Substack host as a substring" test fails. Restore:

```bash
git checkout src/api/substack/image.js
```

Then re-apply Step 3's addition (the checkout discarded it) and re-run Step 4 to confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/image.js src/api/substack/image.spec.js
git commit -m "Add isSubstackHosted, an exact-hostname check for cover images

A cover read back from get_draft is already on substackcdn.com; re-hosting it
would duplicate an asset Substack already serves. Exact match rather than a
substring, or substackcdn.com.evil.example would pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The eight text and enum fields, plus the `only_free` fix

No image work yet. This task is the schema and the forwarding.

**Files:**
- Modify: `src/tools/update_draft.js`
- Modify: `src/tools/update_draft.spec.js`

- [ ] **Step 1: Write the failing tests**

Add these to the `describe('updateDraftSchema', ...)` block in `src/tools/update_draft.spec.js`:

```javascript
  // Measured live 2026-08-08: the API accepts only_free and the editor's Audience control offers it.
  // The enum shipped without it, so a legal value was unreachable through this server.
  test('accepts only_free, which the enum used to refuse', () => {
    assert.deepEqual(
      updateDraftSchema.parse({draft_id: 1, audience: 'only_free'}),
      {draft_id: 1, audience: 'only_free'}
    );
  });

  test('accepts every measured comment permission', () => {
    for (const level of ['everyone', 'subscribers', 'only_paid', 'none']) {
      assert.deepEqual(
        updateDraftSchema.parse({draft_id: 1, write_comment_permissions: level}),
        {draft_id: 1, write_comment_permissions: level}
      );
    }
  });

  // Substack answers a bad write_comment_permissions with {"error":"Something went wrong"} — no
  // field name, no valid set. This enum is the only diagnosis a caller will ever get.
  test('rejects a comment permission outside the enum', () => {
    assert.throws(
      () => updateDraftSchema.parse({draft_id: 1, write_comment_permissions: 'bogus_level'}),
      z.ZodError
    );
  });

  test('accepts every measured comment sort', () => {
    for (const sort of ['best_first', 'most_recent_first', 'oldest_first']) {
      assert.deepEqual(
        updateDraftSchema.parse({draft_id: 1, default_comment_sort: sort}),
        {draft_id: 1, default_comment_sort: sort}
      );
    }
  });

  // These six answer 200 and change nothing — measured one PUT at a time on 2026-08-08. They stay
  // off the schema so strictObject tells the model the key does not exist, rather than letting it
  // believe it scheduled a post or set a language.
  test('rejects the fields the API silently ignores', () => {
    for (const field of [
      'postSchedules',
      'language',
      'email_from_name',
      'is_draft_hidden',
      'ai_detection_disabled',
      'free_unlock_required',
    ]) {
      assert.throws(
        () => updateDraftSchema.parse({draft_id: 1, [field]: 'x'}),
        (error) => /Unrecognized key/.test(error.message) && error.message.includes(field),
        `${field} should be rejected by name`
      );
    }
  });
```

And add this to the `describe('updateDraftHandler', ...)` block:

```javascript
  test('forwards every settings field under its wire name', async () => {
    await updateDraftHandler({
      draft_id: 1,
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_free',
      write_comment_permissions: 'only_paid',
      default_comment_sort: 'most_recent_first',
      social_title: 'Social',
      description: 'Social description',
      search_engine_title: 'SEO title',
      search_engine_description: 'SEO description',
      slug: 'my-post-slug',
    });

    assert.deepEqual(msw.requests.at(-1).body, {
      draft_title: 'T',
      draft_subtitle: 'S',
      audience: 'only_free',
      write_comment_permissions: 'only_paid',
      default_comment_sort: 'most_recent_first',
      social_title: 'Social',
      description: 'Social description',
      search_engine_title: 'SEO title',
      search_engine_description: 'SEO description',
      slug: 'my-post-slug',
    });
  });
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -8
```

Expected: failures on `only_free` (outside the current enum), on the comment-permission and
comment-sort tests (unknown keys), and on the forwarding test. The "silently ignores" test should
already pass — `strictObject` rejects those keys today. That one is a regression guard, not a driver.

- [ ] **Step 3: Replace the schema in `src/tools/update_draft.js`**

Replace the whole `updateDraftSchema` declaration (lines 5-22 of the current file, comment included)
with this:

```javascript
// The API takes a partial body and leaves absent keys alone, so every field here is optional and
// only the ones provided are forwarded. `strictObject` matters more than usual on this tool: the
// wire names are `draft_title`/`draft_subtitle`, and a model reaching for the obvious `title` would
// otherwise be told nothing at all — the call would succeed and change nothing.
//
// The nine settings below are the draft editor's whole Post settings panel, each verified writable
// on 2026-08-08 by a single-key PUT read back with a GET. Six neighbouring fields answer 200 and
// change nothing (`postSchedules`, `language`, `email_from_name`, `is_draft_hidden`,
// `ai_detection_disabled`, `free_unlock_required`) and are deliberately absent, so a caller that
// guesses one is told the key is unrecognised instead of believing the write landed.
export const updateDraftSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to update, as returned by list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  draft_title: z.string().optional().describe("New title. Omit to leave it unchanged."),
  draft_subtitle: z.string().optional().describe("New subtitle. Omit to leave it unchanged."),
  audience: z
    .enum(["everyone", "only_paid", "only_free", "founding"])
    .optional()
    .describe(
      "Who the post is for. `founding` is accepted by the API although the editor does not offer it. " +
        "Omit to leave it unchanged."
    ),
  write_comment_permissions: z
    .enum(["everyone", "subscribers", "only_paid", "none"])
    .optional()
    .describe(
      "Who may comment. `subscribers` means free or paid; `none` disables comments. Omit to leave it " +
        "unchanged."
    ),
  default_comment_sort: z
    .enum(["best_first", "most_recent_first", "oldest_first"])
    .optional()
    .describe("The order comments are shown in. Omit to leave it unchanged."),
  cover_image: z
    .string()
    .url()
    .optional()
    .describe(
      "The post's cover image, used for the social preview. A URL already on " +
        "substack-post-media.s3.amazonaws.com or substackcdn.com is used as-is; any other URL is " +
        "downloaded and re-hosted on Substack first, because Substack server-fetches only its own " +
        "bucket. Private, loopback and link-local hosts are refused. Max 10 MB. HEIC is not accepted. " +
        "Omit to leave it unchanged."
    ),
  social_title: z
    .string()
    .optional()
    .describe(
      "The title shown when the post is shared on other platforms. Distinct from draft_title, which " +
        "is the title on the post itself. Omit to leave it unchanged."
    ),
  description: z
    .string()
    .optional()
    .describe(
      "The description shown in the social preview. This is NOT the subtitle — draft_subtitle is the " +
        "subtitle. Omit to leave it unchanged."
    ),
  search_engine_title: z
    .string()
    .optional()
    .describe(
      "The SEO title. Substack recommends under 60 characters. Omit to leave it unchanged."
    ),
  search_engine_description: z
    .string()
    .optional()
    .describe(
      "The SEO description. Substack recommends 50-160 characters. Omit to leave it unchanged."
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "The post's URL slug, the last segment of its public address. Changing it changes the URL the " +
        "post will be published at. Omit to leave it unchanged."
    ),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `fail 0`. The handler needs no change for these fields — it already spreads whatever
survived validation into the PUT body.

- [ ] **Step 5: Mutate to prove the forwarding test is not vacuous**

```bash
perl -pi -e "s/\"only_free\", //" src/tools/update_draft.js
grep -c "only_free" src/tools/update_draft.js
```

Expected: grep prints `0`. Then:

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the `only_free` test and the forwarding test both fail. Restore:

```bash
git checkout src/tools/update_draft.js
```

Then re-apply Step 3 and re-run Step 4 to confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/update_draft.js src/tools/update_draft.spec.js
git commit -m "Add the Post settings panel's text and enum fields to update_draft

Nine settings, each verified writable by a single-key PUT read back with a
GET. audience gains only_free, which the API accepts and the enum refused.
write_comment_permissions is an enum because Substack rejects a bad value with
{\"error\":\"Something went wrong\"}, naming neither the field nor the valid set.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `cover_image` — pass through, or re-host then PUT

**Files:**
- Modify: `src/tools/update_draft.js`
- Modify: `src/tools/update_draft.spec.js`

- [ ] **Step 1: Write the failing tests**

First extend the imports and setup at the top of `src/tools/update_draft.spec.js`. The file currently
imports `{HttpResponse}` from msw and `{createMswServer, DRAFTS_URL}` from the helper; it needs `http`
and the image constants too:

```javascript
import {http, HttpResponse} from 'msw';
import {updateDraftHandler, updateDraftSchema} from './update_draft.js';
import {createMswServer, DRAFTS_URL, IMAGE_UPLOAD_RESPONSE} from '../../test/helpers/msw-server.js';
```

Then add this below the existing `const msw = createMswServer();` / env setup block:

```javascript
// A public address for the source host, so the SSRF guard passes without touching real DNS.
const publicLookup = async () => [{address: '93.184.216.34', family: 4}];

// A source image served by MSW, and the handler that serves it.
const SOURCE = 'https://images.example.com/cover.jpg';
const sourceHandler = ({body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), type = 'image/jpeg'} = {}) =>
  http.get(SOURCE, () => new HttpResponse(body, {status: 200, headers: {'Content-Type': type}}));

const run = (args, deps = {}) => updateDraftHandler(args, {lookup: publicLookup, ...deps});
```

Now add a new describe block at the end of the file:

```javascript
describe('updateDraftHandler — cover_image', () => {
  const HOSTED = 'https://substack-post-media.s3.amazonaws.com/public/images/existing_1500x1000.jpeg';

  test('forwards a cover already on a Substack host without uploading it', async () => {
    await run({draft_id: 1, cover_image: HOSTED});

    assert.equal(
      msw.requests.filter((r) => r.url.endsWith('/api/v1/image')).length,
      0,
      're-hosting an asset Substack already serves would upload a duplicate'
    );
    assert.deepEqual(msw.requests.at(-1).body, {cover_image: HOSTED});
  });

  test('re-hosts an external cover, then PUTs the returned S3 url', async () => {
    msw.server.use(sourceHandler());

    await run({draft_id: 1, cover_image: SOURCE});

    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.ok(upload, 'an external url must be re-hosted: Substack server-fetches only its own bucket');
    assert.match(upload.body.image, /^data:image\/jpeg;base64,/);

    const put = msw.requests.at(-1);
    assert.equal(put.method, 'PUT');
    assert.deepEqual(put.body, {cover_image: IMAGE_UPLOAD_RESPONSE.url});
  });

  test('uploads before it PUTs, so the draft never points at an un-hosted url', async () => {
    msw.server.use(sourceHandler());

    await run({draft_id: 1, cover_image: SOURCE});

    const uploadIndex = msw.requests.findIndex((r) => r.url.endsWith('/api/v1/image'));
    const putIndex = msw.requests.findIndex((r) => r.method === 'PUT');
    assert.ok(uploadIndex < putIndex, `upload (${uploadIndex}) must precede PUT (${putIndex})`);
  });

  test('reports the url that actually landed, and where it came from', async () => {
    msw.server.use(sourceHandler());

    const result = await run({draft_id: 1, cover_image: SOURCE});

    // Without this the caller cannot learn the url its cover now points at — the same reason
    // set_post_body returns a node tally rather than 'OK'.
    assert.equal(result.cover_image, IMAGE_UPLOAD_RESPONSE.url);
    assert.equal(result.cover_image_rehosted_from, SOURCE);
  });

  test('leaves cover_image_rehosted_from null when nothing was re-hosted', async () => {
    const result = await run({draft_id: 1, cover_image: HOSTED});

    assert.equal(result.cover_image, HOSTED);
    assert.equal(result.cover_image_rehosted_from, null);
  });

  // The reason the re-host runs before the PUT: a failure here must not leave the other fields
  // written while the cover silently kept its old value.
  test('makes no PUT at all when the re-host fails', async () => {
    msw.server.use(
      http.get(SOURCE, () => new HttpResponse('nope', {status: 500, headers: {'Content-Type': 'text/plain'}}))
    );

    await assert.rejects(
      () => run({draft_id: 1, draft_title: 'T', cover_image: SOURCE}),
      /source responded 500/
    );

    assert.equal(
      msw.requests.filter((r) => r.method === 'PUT').length,
      0,
      'a failed re-host must abort before the draft is touched'
    );
  });

  test('refuses a private address for the cover source', async () => {
    await assert.rejects(
      () => updateDraftHandler(
        {draft_id: 1, cover_image: 'http://169.254.169.254/latest/meta-data/'},
        {lookup: async () => [{address: '169.254.169.254', family: 4}]}
      ),
      /private\/loopback/
    );

    assert.equal(msw.requests.filter((r) => r.method === 'PUT').length, 0);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -8
```

Expected: the external-cover tests fail — today the handler forwards `cover_image` verbatim, so no
upload happens and the PUT body carries the external URL. The `HOSTED` pass-through test may already
pass, which is fine: it is the guard that the re-host does not fire on the wrong input.

- [ ] **Step 3: Implement cover resolution in the handler**

In `src/tools/update_draft.js`, add to the imports:

```javascript
import {fetchImageAsDataUri, defaultLookup, isSubstackHosted} from "../api/substack/image.js";
```

Then replace the handler (everything from `export const updateDraftHandler` to the end of the file)
with this:

```javascript
// Derived, never a hand-written list: the message names every settable field, and at eleven of them
// a literal list rots the first time one is added.
const SETTABLE_FIELDS = Object.keys(updateDraftSchema.shape).filter((name) => name !== 'draft_id');

export const updateDraftHandler = async (args, {lookup = defaultLookup, fetchImpl = fetch} = {}) => {
  logger.debug('update_draft.start', {args});

  let validatedArgs;

  try {
    validatedArgs = updateDraftSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('update_draft.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, ...fields} = validatedArgs;

  // A PUT carrying only `{}` is a successful no-op, which reads back as "the update worked" while
  // nothing changed. Refusing here turns that into feedback the caller can act on.
  if (Object.keys(fields).length === 0) {
    logger.error('update_draft.no_fields', {draft_id});
    throw new Error(
      `No fields to update. Provide at least one of: ${SETTABLE_FIELDS.join(', ')}.`
    );
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Resolved BEFORE the PUT, and a failure here throws before the draft is touched: Substack
  // server-fetches only its own bucket, so an external url written straight to cover_image is
  // stored with a 200 and never renders. cover_image has no server-side validation at all — the
  // literal string "not-a-url-at-all" was accepted — so this is the only guard there is.
  let cover_rehosted_from = null;

  if (fields.cover_image !== undefined && !isSubstackHosted(fields.cover_image)) {
    const source = fields.cover_image;

    logger.info('update_draft.cover_image.fetching', {draft_id, url: source});
    const {image, contentType, bytes} = await fetchImageAsDataUri(source, {lookup, fetchImpl});

    // The data URI is deliberately not logged: hundreds of KB of base64 would bury the session.
    logger.info('update_draft.cover_image.uploading', {draft_id, content_type: contentType, bytes});
    // post_id is left null: `POST /api/v1/image` accepts a postId, but its effect is unconfirmed and
    // it was never measured against a draft.
    const uploaded = await substack_api.uploadImage({image, post_id: null});

    fields.cover_image = uploaded.url;
    cover_rehosted_from = source;
    logger.info('update_draft.cover_image.rehosted', {draft_id, from: source, to: uploaded.url});
  }

  const draft = await substack_api.updateDraft(draft_id, fields);

  logger.info('update_draft.done', {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
    cover_image_rehosted_from: cover_rehosted_from,
  });

  return {
    draft_id,
    updated_fields: Object.keys(fields),
    draft_title: draft?.draft_title ?? null,
    draft_subtitle: draft?.draft_subtitle ?? null,
    audience: draft?.audience ?? null,
    is_published: draft?.is_published ?? null,
    // The value that landed, not the one that was asked for: after a re-host they differ, and the
    // caller has no other way to learn the new url.
    cover_image: fields.cover_image ?? draft?.cover_image ?? null,
    cover_image_rehosted_from: cover_rehosted_from,
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `fail 0`.

- [ ] **Step 5: Mutate to prove the re-host tests are not vacuous**

Skipping the re-host entirely is exactly what the old code did, so it is the mutation that matters.
Make the host check always claim the URL is already hosted:

```bash
perl -pi -e "s/!isSubstackHosted\(fields\.cover_image\)/false/" src/tools/update_draft.js
grep -n "fields.cover_image !== undefined && false" src/tools/update_draft.js
```

Expected: grep prints the line — this confirms the mutation landed. A `perl` regex that fails to match
leaves the file untouched and reads exactly like a test that asserts nothing.

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -6
```

Expected: at least four failures — "re-hosts an external cover", "uploads before it PUTs", "reports the
url that actually landed", "makes no PUT at all when the re-host fails" and "refuses a private address".
Restore:

```bash
git checkout src/tools/update_draft.js
```

Then re-apply Step 3 (the checkout discarded it) and re-run Step 4 to confirm green.

- [ ] **Step 5b: Mutate the ordering specifically**

The previous mutation proves the re-host happens; it does not prove it happens *first*. Make the PUT
run before it by hoisting the `updateDraft` call:

```bash
perl -0pi -e "s/(  let cover_rehosted_from = null;)/  const draft = await substack_api.updateDraft(draft_id, fields);\n\$1/" src/tools/update_draft.js
perl -0pi -e "s/\n  const draft = await substack_api\.updateDraft\(draft_id, fields\);\n\n  logger\.info\('update_draft\.done'/\n  logger.info('update_draft.done'/" src/tools/update_draft.js
grep -c "updateDraft(draft_id, fields)" src/tools/update_draft.js
```

Expected: grep prints `1` — one call, now hoisted above the re-host. If it prints `2`, the second
substitution did not match and the file has two calls; fix it by hand before continuing.

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -4
```

Expected: "uploads before it PUTs" and "makes no PUT at all when the re-host fails" both fail — the
PUT now precedes the upload, and a failing download leaves the draft already written. Restore:

```bash
git checkout src/tools/update_draft.js
```

Then re-apply Step 3 and re-run Step 4 to confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/update_draft.js src/tools/update_draft.spec.js
git commit -m "Set a draft's cover_image, re-hosting an external url first

Substack stores whatever string it is given — \"not-a-url-at-all\" answered 200
— and server-fetches only its own bucket, so an external cover is accepted and
never renders. The re-host runs before the PUT: a download failure must not
leave the other fields written with the cover silently unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Derive the no-fields message from the schema

Task 4 already introduced `SETTABLE_FIELDS`. This task pins it with a test, so a future field cannot
be added without appearing in the message.

**Files:**
- Modify: `src/tools/update_draft.spec.js`

- [ ] **Step 1: Write the failing test**

Add to the `describe('updateDraftHandler', ...)` block:

```javascript
  // Derived from the schema, not hand-written: the message used to list three field names literally,
  // which silently stops being true the first time a field is added.
  test('the no-fields message names every settable field and no others', async () => {
    const error = await updateDraftHandler({draft_id: 1}).catch((e) => e);

    const expected = Object.keys(updateDraftSchema.shape).filter((name) => name !== 'draft_id');
    for (const field of expected) {
      assert.ok(error.message.includes(field), `the message should name ${field}`);
    }
    assert.ok(!error.message.includes('draft_id'), 'draft_id is required, not a settable field');
  });
```

- [ ] **Step 2: Run it — it should pass, and that is the point**

```bash
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `fail 0`. Task 4's implementation already satisfies it. A test that passes on its first run
has proven nothing yet, which is what Step 3 is for.

- [ ] **Step 3: Mutate to prove it is not vacuous**

Put the old hand-written list back:

```bash
perl -0pi -e "s/\\\$\{SETTABLE_FIELDS\.join\(', '\)\}/draft_title, draft_subtitle, audience/" src/tools/update_draft.js
grep -n "draft_title, draft_subtitle, audience" src/tools/update_draft.js
```

Expected: grep prints the line. Then:

```bash
npm test 2>&1 | grep -E '^(not ok|✖)' | head -3
```

Expected: the new test fails, naming a field the message no longer mentions (`cover_image` or
`slug`). Restore:

```bash
git checkout src/tools/update_draft.js
npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'
```

Expected: `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/tools/update_draft.spec.js
git commit -m "Pin the no-fields message to the schema's own field list

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Update the registry description, README and CLAUDE.md

The tool description is what a model reads before choosing the tool, so a stale one is a functional
bug, not a docs nit.

**Files:**
- Modify: `src/server.js:100-107`
- Modify: `README.md:173`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the registry description**

In `src/server.js`, replace the `update_draft` entry's `description` with:

```javascript
    description:
      "Change an existing draft's title, subtitle or any of its Post settings: audience, who may " +
      "comment, comment order, cover image, social preview title and description, SEO title and " +
      "description, and URL slug. The update is partial: only the fields you pass change, everything " +
      "else — including the body — is left alone. A cover_image not already hosted by Substack is " +
      "downloaded and re-hosted first. Take the id from list_posts or create_draft_post.",
```

- [ ] **Step 2: Update the README block**

In `README.md`, replace the whole `update_draft` `<details>` block (lines 172-184) with this:

```html
<details>
<summary><strong>update_draft</strong> - Change a draft's title, subtitle or any of its Post settings</summary>

The update is **partial**: only the fields you pass change, and the body is left alone.

**Inputs**:
- `draft_id` (number): the id returned by `list_posts` or `create_draft_post`
- `draft_title` (string, optional)
- `draft_subtitle` (string, optional)
- `audience` (`everyone` | `only_paid` | `only_free` | `founding`, optional)
- `write_comment_permissions` (`everyone` | `subscribers` | `only_paid` | `none`, optional): who may comment
- `default_comment_sort` (`best_first` | `most_recent_first` | `oldest_first`, optional)
- `cover_image` (string, optional): the social preview image. A URL already on `substack-post-media.s3.amazonaws.com` or `substackcdn.com` is used as-is; anything else is downloaded and re-hosted on Substack first, under the same guards as `upload_image`
- `social_title` (string, optional): the title used when the post is shared elsewhere
- `description` (string, optional): the social preview description — *not* the subtitle
- `search_engine_title` (string, optional)
- `search_engine_description` (string, optional)
- `slug` (string, optional): the post's URL slug

**Returns**: `{draft_id, updated_fields, draft_title, draft_subtitle, audience, is_published, cover_image, cover_image_rehosted_from}`.
A call with no field to change is refused rather than sent as a no-op. `cover_image` is the URL that
actually landed, which differs from the one passed when it was re-hosted.
</details>
```

Confirm the line numbers before editing — `sed -n '170,186p' README.md` should show the block starting
at `<details>` and ending at `</details>`.

- [ ] **Step 3: Add the measured facts to CLAUDE.md**

In the "Substack's private API" section, immediately after the paragraph beginning **"The draft
lifecycle is four verbs on one path."**, insert:

```markdown
**The draft's Post settings panel is nine writable fields, and six of its neighbours are lies.**
Verified 2026-08-08, each by a single-key `PUT /api/v1/drafts/:id` read back with a `GET`:
`audience` (`everyone|only_paid|only_free|founding` — the panel offers the first three, the API takes
`founding` too), `write_comment_permissions` (`everyone|subscribers|only_paid|none`),
`default_comment_sort` (`best_first|most_recent_first|oldest_first`), `cover_image`, `social_title`,
`description` (the social preview's, *not* the subtitle), `search_engine_title`,
`search_engine_description` and `slug`. The panel's DOM is the source for the enums — its controls
are real inputs carrying `name`/`value` — but the UI names are not the wire names: `commentLevel` is
`write_comment_permissions`, `commentSort` is `default_comment_sort`.

Three traps, all of them this API's signature move:

- **Six fields answer 200 and change nothing:** `postSchedules`, `language`, `email_from_name`,
  `is_draft_hidden`, `ai_detection_disabled`, `free_unlock_required`. That is the **seventh** distinct
  silent-ignore here, and `postSchedules` is the dangerous one — scheduling looks settable through
  the draft and is not, so it needs an endpoint this server does not yet have.
- **The validation is asymmetric, and it fails worst where it matters most.** A bad `audience`,
  `default_comment_sort` or `meter_type` answers 400 *naming* the parameter and its value; a bad
  `draft_section_id` answers 400 `"Section not found"`. But a bad `write_comment_permissions` answers
  `{"error":"Something went wrong","type":"single"}` — no field, no valid set. Its zod enum is the
  only diagnosis a caller will ever get, which is why it is an enum and not a string.
- **`cover_image` is not validated at all.** The literal string `"not-a-url-at-all"` was accepted
  with a 200 and stored, and so was an external Wikimedia URL. Substack will never say that a cover
  cannot render — the same failure the fork's external `logo_url`/`photo_url` hit. `update_draft`
  therefore forwards a URL on `substack-post-media.s3.amazonaws.com` or `substackcdn.com` unchanged
  and re-hosts anything else through `POST /api/v1/image` first, since Substack server-fetches only
  its own bucket. The re-host runs *before* the PUT so a download failure cannot leave the other
  eight fields written.

`meter_type` takes only `none` and `metered`; every other value 400s. It, `should_send_email`,
`should_send_free_preview`, `explicit`, `hide_from_feed`, `show_guest_bios`,
`exempt_from_archive_paywall` and `podcast_description` are all writable and all deliberately
unexposed — the panel is the boundary. `should_send_email` especially: `publish_draft` already writes
it as the publish intent, and a second door onto the one flag that can mail the whole list buys
convenience at the cost of the irreversible.
```

Then update the image paragraph: the sentence describing `upload_image`'s SSRF guard should note that
the pipeline now lives in `src/api/substack/image.js` and is shared with `update_draft`'s
`cover_image`. And in the **Layout** section, add `image.js` to the `src/api/substack/` line.

- [ ] **Step 4: Verify the protocol surface changed only where intended**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SUBSTACK_PUBLICATION_URL=https://test.substack.com SUBSTACK_SESSION_TOKEN=tok SUBSTACK_USER_ID=1 \
    timeout 5 node src/index.js 2>/dev/null | sed -n '2p' \
  | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin)['result']['tools'] if x['name']=='update_draft'][0]; print(sorted(t['inputSchema']['properties'])); print('additionalProperties:', t['inputSchema'].get('additionalProperties'))"
```

Expected: the eleven settable fields plus `draft_id`, and `additionalProperties: False`. A missing
`additionalProperties` means `strictObject` was lost — that has silently regressed in this repo before.

- [ ] **Step 5: Commit**

```bash
git add src/server.js README.md CLAUDE.md
git commit -m "Document the draft settings surface and its three traps

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Verify at both ends of the supported range

**Files:** none — verification only.

- [ ] **Step 1: Run the suite on the pinned runtime and on the engines floor**

```bash
source ~/.nvm/nvm.sh && nvm exec --silent 22 npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `# fail 0` (Node 22 reports TAP, so the tally is `# pass`, failures `not ok`).

```bash
source ~/.nvm/nvm.sh && nvm use && npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)|^(not ok|✖)'
```

Expected: `ℹ fail 0` (Node 24 uses the spec reporter).

- [ ] **Step 2: Confirm the session token never reaches the log**

The cover-image path added a new `SubstackApi` call site, and `SubstackApi` logs every request.

```bash
npm test 2>&1 | grep -iE "SUBSTACK_SESSION_TOKEN|test-token" | head
```

Expected: no output. Any hit means a header or env value is being logged unredacted.

- [ ] **Step 3: Check the packaged artifact still excludes the new spec**

```bash
npm pack --dry-run 2>&1 | grep -cE "\.spec\.js"
```

Expected: `0`. `src/api/substack/image.spec.js` is new, and the `files` negation pattern must cover it.

- [ ] **Step 4: Live check against the real API — the one thing the suite cannot do**

Every measurement behind this plan used the browser session cookie, not `SUBSTACK_SESSION_TOKEN` in a
header through `SubstackApi`. That gap is already flagged in `CLAUDE.md` as the first thing to check
if `upload_image` misbehaves, and it applies identically here.

Ask the user before running this — it writes to a real draft. Create a scratch draft, set every
field on it including an external cover, read it back, confirm each value landed and that
`cover_image` is on `substack-post-media.s3.amazonaws.com`, then delete the draft. If anything comes
back unchanged, the field is a silent-ignore that the single-key probe missed and it must come off
the schema.

- [ ] **Step 5: Final commit if anything changed**

```bash
git status --short
```

Expected: clean. If Step 4 forced a schema change, commit it with the measurement in the message.

---

## Out of scope, recorded so it is not re-litigated

- **Scheduling.** `postSchedules` through `PUT /drafts/:id` answers 200 and stores `[]`. It needs its
  own endpoint, unfound so far.
- **`draft_section_id`.** The server validates the id (400 `"Section not found"`), but
  `implementing.substack.com` has no sections, so the success path cannot be verified. Unverified
  writes do not ship.
- **`should_send_email`** and the other seven writable-but-unexposed fields. See CLAUDE.md's new
  paragraph for the reasoning.
