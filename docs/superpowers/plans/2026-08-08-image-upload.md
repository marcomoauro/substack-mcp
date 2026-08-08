# upload_image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `upload_image` MCP tool that downloads an external image URL, re-encodes it as a data URI, and uploads it to Substack via `POST /api/v1/image`, returning a Substack-hosted URL usable in `image2.src`.

**Architecture:** One new tool file `src/tools/upload_image.js` (zod schema + handler) plus one `SubstackApi.uploadImage()` method and one registry entry in `src/server.js`. The handler fetches the caller's URL through an injectable `fetchImpl`, guards it (scheme allow-list, DNS-resolved SSRF block via an injectable `lookup`, size cap, `image/*`/anti-HEIC content-type check), base64-encodes the bytes into a `data:` URI, and hands that to `SubstackApi.uploadImage`. All outbound HTTP is mocked with MSW; DNS is never touched in tests because `lookup` is injected.

**Tech Stack:** Node ≥22 (dev on 24), ESM, zod 4, `@modelcontextprotocol/sdk` `McpServer.registerTool`, `node:dns`/`node:net`, MSW, `node --test`.

**Reference spec:** `docs/superpowers/specs/2026-08-08-image-upload-design.md`

---

## File structure

- **Create** `src/tools/upload_image.js` — schema, SSRF/validation helpers, handler. Exports `uploadImageSchema`, `uploadImageHandler`, `isPrivateAddress`, `MAX_IMAGE_BYTES`.
- **Create** `src/tools/upload_image.spec.js` — colocated tests.
- **Modify** `src/api/substack/SubstackApi.js` — add `uploadImage({image, post_id})`.
- **Modify** `src/api/substack/SubstackApi.spec.js` — test the new method.
- **Modify** `test/helpers/msw-server.js` — add `IMAGE_URL`, `IMAGE_UPLOAD_RESPONSE`, `imageUploadHandler`, register and export it.
- **Modify** `src/server.js` — import and register `upload_image`.
- **Modify** `CLAUDE.md`, `README.md` — correct the "cannot upload" record.

Test-output note (from `CLAUDE.md`): on Node 24 the reporter tallies `ℹ pass` and marks failures `✖`; on the Node 22 floor it is TAP (`# pass`, `not ok`). Grep both when scripting: `grep -E '^(#|ℹ) (tests|pass|fail)'` and `grep -E '^(not ok|✖)'`.

---

## Task 1: `SubstackApi.uploadImage()`

**Files:**
- Modify: `src/api/substack/SubstackApi.js` (add method next to `postDraft`, around line 155)
- Modify: `test/helpers/msw-server.js` (add `IMAGE_URL`, `IMAGE_UPLOAD_RESPONSE`, `imageUploadHandler`)
- Test: `src/api/substack/SubstackApi.spec.js`

- [ ] **Step 1: Add the MSW image-upload handler and fixtures**

In `test/helpers/msw-server.js`, add the URL constant next to the other `API`-based constants (after `DRAFTS_URL`, ~line 12):

```js
export const IMAGE_URL = `${API}/image`;
```

Add a response fixture near the other `*_RESPONSE` fixtures (e.g. after `DRAFT_RESPONSE`, ~line 58). These are the exact keys the live endpoint returned on 2026-08-08:

```js
export const IMAGE_UPLOAD_RESPONSE = {
  id: 'test-image-id',
  url: 'https://substack-post-media.s3.amazonaws.com/public/images/test-image.jpg',
  contentType: 'image/jpeg',
  bytes: 82768,
  imageWidth: 1200,
  imageHeight: 630,
};
```

Add the handler builder next to `draftsHandler` (~line 563):

```js
  function imageUploadHandler(responder) {
    return http.post(IMAGE_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }
```

Register it in the `setupServer(...)` list (next to `draftsHandler(...)`, ~line 791):

```js
    imageUploadHandler(() => HttpResponse.json(IMAGE_UPLOAD_RESPONSE, {status: 200})),
```

Expose it in the returned object (next to `draftsHandler,`, ~line 843):

```js
    imageUploadHandler,
```

- [ ] **Step 2: Write the failing test**

In `src/api/substack/SubstackApi.spec.js`, add the import for `IMAGE_URL` and `IMAGE_UPLOAD_RESPONSE` to the existing `msw-server.js` import block, then add:

```js
describe('SubstackApi — uploadImage', () => {
  test('POSTs the data URI as JSON and returns the parsed body', async () => {
    const api = createApi();
    let seen;
    msw.server.use(
      msw.imageUploadHandler(async () => HttpResponse.json(IMAGE_UPLOAD_RESPONSE, {status: 200}))
    );

    const result = await api.uploadImage({image: 'data:image/jpeg;base64,QUJD'});

    seen = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.deepEqual(seen.body, {image: 'data:image/jpeg;base64,QUJD'});
    assert.equal(result.url, IMAGE_UPLOAD_RESPONSE.url);
    assert.equal(result.bytes, 82768);
  });

  test('includes postId only when post_id is given', async () => {
    const api = createApi();
    await api.uploadImage({image: 'data:image/png;base64,QQ==', post_id: 42});
    const seen = msw.requests.filter((r) => r.url.endsWith('/api/v1/image')).pop();
    assert.deepEqual(seen.body, {image: 'data:image/png;base64,QQ==', postId: 42});
  });

  test('omits postId when post_id is absent', async () => {
    const api = createApi();
    await api.uploadImage({image: 'data:image/png;base64,QQ=='});
    const seen = msw.requests.filter((r) => r.url.endsWith('/api/v1/image')).pop();
    assert.deepEqual(Object.keys(seen.body), ['image']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- 2>&1 | grep -iE 'uploadImage|not ok|✖|TypeError'`
Expected: failures — `api.uploadImage is not a function`.

- [ ] **Step 4: Implement the method**

In `src/api/substack/SubstackApi.js`, add after `postDraft` (~line 157):

```js
  /**
   * Uploads an image. The body is a data URI under `image`, not a file or a URL — the editor builds
   * it from `canvas.toDataURL()`. Verified live 2026-08-08: 200 with {id, url, contentType, bytes,
   * imageWidth, imageHeight}. `post_id` maps to the API's `postId`; an absent one must not be sent as
   * null (same partial-body rule as everywhere else here).
   */
  async uploadImage({image, post_id = null}) {
    return this.request({
      method: 'POST',
      path: '/image',
      body: post_id === null ? {image} : {image, postId: post_id},
      referer: '/publish/post',
    });
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- 2>&1 | grep -iE 'uploadImage'`
Expected: the three `uploadImage` tests pass (`ℹ`/`ok`), no `not ok`/`✖`.

- [ ] **Step 6: Commit**

```bash
git add src/api/substack/SubstackApi.js src/api/substack/SubstackApi.spec.js test/helpers/msw-server.js
git commit -m "Add SubstackApi.uploadImage: JSON data-URI POST to /api/v1/image"
```

---

## Task 2: `upload_image` schema and happy path

**Files:**
- Create: `src/tools/upload_image.js`
- Test: `src/tools/upload_image.spec.js`

- [ ] **Step 1: Write the failing test**

Create `src/tools/upload_image.spec.js`:

```js
import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {http, HttpResponse} from 'msw';
import {uploadImageHandler, uploadImageSchema, MAX_IMAGE_BYTES, isPrivateAddress} from './upload_image.js';
import {createMswServer, IMAGE_URL, IMAGE_UPLOAD_RESPONSE} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';
import {captureLogs} from '../../test/helpers/capture-logs.js';

const msw = createMswServer();
let restoreEnv;

before(() => {
  restoreEnv = setTestEnv();
  msw.start();
});
afterEach(() => msw.reset());
after(() => {
  msw.stop();
  restoreEnv();
});

// A public address for the source host, so the SSRF guard passes without touching real DNS.
const publicLookup = async () => [{address: '93.184.216.34', family: 4}];

// A source image served by MSW. `bytes`/`type` let each test shape size and content-type.
const SOURCE = 'https://images.example.com/photo.jpg';
function sourceHandler({body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), type = 'image/jpeg'} = {}) {
  return http.get(SOURCE, () => new HttpResponse(body, {status: 200, headers: {'Content-Type': type}}));
}

const run = (args, deps = {}) =>
  uploadImageHandler(args, {lookup: publicLookup, ...deps});

describe('uploadImageHandler — happy path', () => {
  test('downloads, encodes as a data URI, uploads, returns the mapped fields', async () => {
    msw.server.use(sourceHandler());
    const result = await run({url: SOURCE});

    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.match(upload.body.image, /^data:image\/jpeg;base64,/);
    assert.equal(upload.body.postId, undefined);

    assert.deepEqual(result, {
      id: IMAGE_UPLOAD_RESPONSE.id,
      url: IMAGE_UPLOAD_RESPONSE.url,
      content_type: IMAGE_UPLOAD_RESPONSE.contentType,
      bytes: IMAGE_UPLOAD_RESPONSE.bytes,
      width: IMAGE_UPLOAD_RESPONSE.imageWidth,
      height: IMAGE_UPLOAD_RESPONSE.imageHeight,
    });
  });

  test('forwards post_id as postId to the upload', async () => {
    msw.server.use(sourceHandler());
    await run({url: SOURCE, post_id: 7});
    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.equal(upload.body.postId, 7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- 2>&1 | grep -iE 'upload_image|Cannot find|not ok|✖'`
Expected: failure — module `./upload_image.js` not found.

- [ ] **Step 3: Implement the minimal tool**

Create `src/tools/upload_image.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- 2>&1 | grep -iE 'happy path|not ok|✖'`
Expected: both happy-path tests pass, no `not ok`/`✖`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/upload_image.js src/tools/upload_image.spec.js
git commit -m "Add upload_image tool: fetch, encode as data URI, upload"
```

---

## Task 3: content-type and HEIC validation

**Files:**
- Test: `src/tools/upload_image.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/tools/upload_image.spec.js`:

```js
describe('uploadImageHandler — content validation', () => {
  test('rejects a non-image source before uploading', async () => {
    msw.server.use(sourceHandler({body: Buffer.from('<html>'), type: 'text/html'}));
    await assert.rejects(run({url: SOURCE}), /not an image/);
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });

  test('rejects HEIC with a convert message', async () => {
    msw.server.use(sourceHandler({type: 'image/heic'}));
    await assert.rejects(run({url: SOURCE}), /HEIC is not accepted/);
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });
});
```

- [ ] **Step 2: Run to verify it passes (behavior already implemented in Task 2)**

Run: `npm test -- 2>&1 | grep -iE 'content validation|not ok|✖'`
Expected: PASS. This task exists to lock the behavior with tests. To confirm the tests are real, temporarily change `startsWith('image/')` to `startsWith('')` in `upload_image.js`, run — the non-image test must fail — then restore. Grep the file for `startsWith('image/')` to confirm the revert landed before trusting the green run.

- [ ] **Step 3: Commit**

```bash
git add src/tools/upload_image.spec.js
git commit -m "Test upload_image content-type and HEIC rejection"
```

---

## Task 4: scheme and SSRF guards

**Files:**
- Test: `src/tools/upload_image.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/tools/upload_image.spec.js`:

```js
describe('isPrivateAddress', () => {
  test('flags loopback, private, link-local, unique-local; allows public', () => {
    assert.equal(isPrivateAddress('127.0.0.1', 4), true);
    assert.equal(isPrivateAddress('10.1.2.3', 4), true);
    assert.equal(isPrivateAddress('172.16.0.1', 4), true);
    assert.equal(isPrivateAddress('192.168.1.1', 4), true);
    assert.equal(isPrivateAddress('169.254.169.254', 4), true);
    assert.equal(isPrivateAddress('93.184.216.34', 4), false);
    assert.equal(isPrivateAddress('::1', 6), true);
    assert.equal(isPrivateAddress('fe80::1', 6), true);
    assert.equal(isPrivateAddress('fd00::1', 6), true);
    assert.equal(isPrivateAddress('::ffff:127.0.0.1', 6), true);
    assert.equal(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946', 6), false);
  });
});

describe('uploadImageHandler — SSRF and scheme guards', () => {
  test('rejects a host that resolves to a private address, without fetching', async () => {
    let fetched = false;
    const fetchImpl = async () => { fetched = true; return new HttpResponse(); };
    const privateLookup = async () => [{address: '169.254.169.254', family: 4}];
    await assert.rejects(
      uploadImageHandler({url: 'http://metadata.internal/'}, {lookup: privateLookup, fetchImpl}),
      /private\/loopback/
    );
    assert.equal(fetched, false);
  });

  test('rejects a non-http(s) scheme up front', async () => {
    await assert.rejects(run({url: 'ftp://example.com/x.png'}), /only http and https/);
  });
});
```

Note: `z.string().url()` accepts `ftp://…`, so the scheme check in `assertPublicUrl` is what rejects it — this test proves that guard, not the schema.

- [ ] **Step 2: Run to verify it passes (behavior implemented in Task 2)**

Run: `npm test -- 2>&1 | grep -iE 'SSRF|isPrivateAddress|not ok|✖'`
Expected: PASS. To confirm the SSRF test is real, temporarily make `isPrivateAddress` always return `false`, run — the "resolves to a private address" test must fail — then restore and grep to confirm.

- [ ] **Step 3: Commit**

```bash
git add src/tools/upload_image.spec.js
git commit -m "Test upload_image scheme allow-list and DNS-resolved SSRF guard"
```

---

## Task 5: size cap

**Files:**
- Test: `src/tools/upload_image.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/tools/upload_image.spec.js`:

```js
describe('uploadImageHandler — size cap', () => {
  test('rejects an image over MAX_IMAGE_BYTES before uploading', async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff);
    msw.server.use(sourceHandler({body: big, type: 'image/png'}));
    await assert.rejects(run({url: SOURCE}), /over the .* limit/);
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });

  test('accepts an image exactly at the limit', async () => {
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES, 0xff);
    msw.server.use(sourceHandler({body: atLimit, type: 'image/png'}));
    const result = await run({url: SOURCE});
    assert.equal(result.url, IMAGE_UPLOAD_RESPONSE.url);
  });
});
```

- [ ] **Step 2: Run to verify it passes (behavior implemented in Task 2)**

Run: `npm test -- 2>&1 | grep -iE 'size cap|not ok|✖'`
Expected: PASS. To confirm the cap test is real, temporarily change `> MAX_IMAGE_BYTES` to `> MAX_IMAGE_BYTES * 1000`, run — the oversize test must fail — then restore and grep to confirm.

- [ ] **Step 3: Commit**

```bash
git add src/tools/upload_image.spec.js
git commit -m "Test upload_image size cap at MAX_IMAGE_BYTES"
```

---

## Task 6: register the tool in the server

**Files:**
- Modify: `src/server.js`
- Test: `src/server.spec.js`

- [ ] **Step 1: Write the failing test**

In `src/server.spec.js`, find where the harness lists tools (search for `tools/list` or `listTools`). Add:

```js
test('upload_image is registered and advertises url + post_id', async () => {
  const client = await connectMcpClient();
  const {tools} = await client.listTools();
  const tool = tools.find((t) => t.name === 'upload_image');
  assert.ok(tool, 'upload_image should be registered');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['post_id', 'url']);
  assert.equal(tool.inputSchema.additionalProperties, false);
});
```

If `connectMcpClient`/`listTools` is not the local idiom, mirror the nearest existing tools/list test in the file.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- 2>&1 | grep -iE 'upload_image is registered|not ok|✖'`
Expected: FAIL — `upload_image should be registered`.

- [ ] **Step 3: Register the tool**

In `src/server.js`, add the import next to the other tool imports:

```js
import {uploadImageSchema, uploadImageHandler} from "./tools/upload_image.js";
```

Add the registry entry inside the `tools` object (e.g. after `set_post_body`):

```js
  upload_image: {
    description:
      "Upload an image to your Substack publication from an http(s) URL. The server downloads the " +
      "image and re-hosts it on Substack; the returned url is what goes into image2.src in " +
      "set_post_body. Private/loopback hosts are refused, HEIC is not accepted, max 10 MB.",
    schema: uploadImageSchema,
    handler: uploadImageHandler,
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- 2>&1 | grep -iE 'upload_image is registered|not ok|✖'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/server.spec.js
git commit -m "Register upload_image in the tools registry"
```

---

## Task 7: logging assertions

**Files:**
- Test: `src/tools/upload_image.spec.js`

- [ ] **Step 1: Write the failing test**

Append to `src/tools/upload_image.spec.js`:

```js
describe('uploadImageHandler — logging', () => {
  test('logs intent before the request and never logs the data URI', async () => {
    msw.server.use(sourceHandler());
    const {logs} = await captureLogs(() => run({url: SOURCE}));
    const events = logs.map((l) => l.msg);
    assert.ok(events.includes('upload_image.fetching'));
    assert.ok(events.includes('upload_image.uploading'));
    // The base64 payload must never appear in any log line.
    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes('base64,'), false);
  });
});
```

Confirm the `captureLogs` return shape against `test/helpers/capture-logs.js`; if it returns the array directly rather than `{logs}`, adjust the destructuring to match the existing idiom in another spec (e.g. `export_subscribers.spec.js`).

- [ ] **Step 2: Run to verify it passes (behavior implemented in Task 2)**

Run: `npm test -- 2>&1 | grep -iE 'logging|never logs|not ok|✖'`
Expected: PASS. To confirm the redaction test is real, temporarily add `logger.info('leak', {image})` before the upload in `upload_image.js`, run — the "never logs the data URI" test must fail — then remove it and grep to confirm the line is gone.

- [ ] **Step 3: Commit**

```bash
git add src/tools/upload_image.spec.js
git commit -m "Test upload_image logs intent and never logs the data URI"
```

---

## Task 8: correct the documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Rewrite the CLAUDE.md limit paragraph**

In `CLAUDE.md`, find the paragraph beginning "**Images can be referenced but not uploaded**" and the sentence "**Do not implement an upload from either.**" Replace the "all three hang / do not implement" claim with the measured reality. Keep it in the file's voice (why, not just what):

```markdown
**Images can be uploaded after all, and `upload_image` is how.** `POST /api/v1/image` was recorded
here as hanging in all three tested encodings; re-measured live 2026-08-08, it answers **200** — the
body is JSON `{image: "data:<mime>;base64,…"}`, a **data URI**, not a file or a URL. Multipart and
form-urlencoded failed because they sent the wrong thing, not for a header detail or a Cloudflare
wall. The response is `{id, url, contentType, bytes, imageWidth, imageHeight}`, `url` on
`substack-post-media.s3.amazonaws.com` — the same host all `image2.src` values use, and it renders
through Substack's CDN (proven end to end on a real draft). **Substack server-fetches only its own S3
bucket**: an external URL as `image` answers `400 "Failed to fetch image"`, so `upload_image`
downloads the URL itself and re-encodes it. It guards that download — http(s) only, DNS-resolved SSRF
block, `image/*` (HEIC refused early, as the dashboard does), and a 10 MB cap that is **ours, not
Substack's** (the bundle's `MAX_FILE_SIZE` could not be read). The data URI is never logged. **Still
unverified:** the live checks used the browser session cookie, not `SUBSTACK_SESSION_TOKEN` in a
header — confirm that path first.
```

- [ ] **Step 2: Update the README image line**

In `README.md` around line 143, replace the "An image must already be hosted by Substack" line with a pointer to the tool:

```markdown
- **Images:** `upload_image` takes an http(s) image URL, re-hosts it on Substack, and returns a
  `url` you put in `image2.src`. External URLs placed directly in `image2.src` do not render.
```

Also update the tool list around `README.md:124`/`README.md:134` if it enumerates tools, adding `upload_image`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Correct the docs: images can be uploaded via upload_image"
```

---

## Task 9: full-suite verification at both Node versions

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite on the dev version**

Run: `npm test 2>&1 | tail -20`
Expected: all pass. Grep both reporter shapes: `npm test 2>&1 | grep -E '^(#|ℹ) (tests|pass|fail)'` and confirm no `grep -E '^(not ok|✖)'` output.

- [ ] **Step 2: Run at the engines floor (Node 22)**

Run: `source ~/.nvm/nvm.sh && nvm exec --silent 22 npm test 2>&1 | grep -E '^(#|not ok) '`
Expected: `# fail 0`, no `not ok` lines. (TAP reporter on 22.)

- [ ] **Step 3: Confirm the tool is advertised over the real protocol**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SUBSTACK_PUBLICATION_URL=https://test.substack.com SUBSTACK_SESSION_TOKEN=tok SUBSTACK_USER_ID=1 \
    timeout 5 node src/index.js | grep -o '"upload_image"'
```
Expected: `"upload_image"` printed.

- [ ] **Step 4: Final commit if anything was adjusted during verification**

```bash
git add -A && git commit -m "Verify upload_image across Node 22 and 24" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** interface (Task 2, 6), download+encode (Task 2), scheme/SSRF guards (Task 4), size cap (Task 5), content-type/HEIC (Task 3), API method + postId mapping (Task 1), logging incl. no-data-URI (Task 7), docs correction (Task 8), auth caveat recorded in docs and left as the stated open item (Task 8, verified-only in Task 9 without the header path — flagged, not silently closed). All spec sections map to a task.
- **Type consistency:** `uploadImage({image, post_id})` (Task 1) matches the call in Task 2; response keys `contentType/imageWidth/imageHeight` map to output `content_type/width/height` consistently in Task 2's test and impl; `isPrivateAddress(address, family)` signature identical in impl and Task 4 tests; `MAX_IMAGE_BYTES` used identically in impl and Task 5.
- **Known limitation (from spec, intentional):** the SSRF check resolves DNS then fetches by URL — a TOCTOU window the spec accepted; not closed here.
