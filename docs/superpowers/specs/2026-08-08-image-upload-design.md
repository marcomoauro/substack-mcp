# Image upload — design

**Date:** 2026-08-08
**Status:** approved, ready for a plan
**Supersedes:** the "Images can be referenced but not uploaded" limit documented in `CLAUDE.md`
and `README.md:143`, and the instruction "Do not implement an upload from either" fork signature.

## Why this exists

`captionedImage` is in 60 of 60 sampled posts, and until now `image2.src` had to already point at a
Substack-hosted asset — there was no way to put a new image into a post. `CLAUDE.md` recorded the
endpoint as unreachable: `POST /api/v1/image` "hangs" in all three tested encodings (JSON,
form-urlencoded, multipart), attributed by analogy to the Cloudflare wall on `POST /comment/feed`.

**That record is wrong, and this design rests on re-measuring it live on 2026-08-08** against
`implementing.substack.com`, from the authenticated dashboard. The endpoint works. The three earlier
encodings all failed because they sent the wrong *thing*, not because of a header detail or a bot
wall:

- **The body is JSON `{image: "data:<mime>;base64,…"}` — a data URI, not a file and not a URL.** In
  the `reactPublish` bundle the call is built from `canvas.toDataURL()` / a read `File`, then
  `post('/api/v1/image').send({image, postId})`. Multipart and form-urlencoded were never going to
  work; the "hang" was the wrong shape, not Cloudflare.

Measured, live, that day (every row a real `POST`):

| Probe | Result |
|---|---|
| 1×1 PNG as data URI | **200**, 276 ms |
| Real JPEG 1200×630 (108 KB payload) as data URI | **200**, 485 ms; returns correct `bytes`/`width`/`height` |
| With `postId` of a real published post | **200** — accepted |
| A `substack-post-media` S3 URL as `image` | **200** — Substack server-fetches its *own* bucket |
| An **external** URL (Wikimedia) as `image` | **400 `Failed to fetch image`** |
| Non-image content (`text/plain` data URI) | **400 `{error, type}`** — Substack validates server-side |
| The returned S3 URL, fetched with no cookie | **200, `content-type: image`** — the asset is public |

**Response shape:** `{id, url, contentType, bytes, imageWidth, imageHeight}`. `url` is on
`substack-post-media.s3.amazonaws.com` — the exact host all 18 `image2.src` values in 6 sampled
published posts use.

### The end-to-end loop is proven, not inferred

On draft `210218832`, live: fresh data-URI upload → build a `captionedImage` node (attrs copied
verbatim from a real post) referencing the returned `url` → append to the draft's existing body →
`PUT /drafts/:id` (200, node persisted) → reload the editor. The image **renders**: `complete`,
natural size 1038×581, and served through Substack's own CDN
(`substackcdn.com/image/fetch/…f_webp`) — it entered the render pipeline, not just the stored JSON.
The draft was then restored to its original 6 nodes.

**The one thing not yet proven:** every call above used the browser's session **cookie**. The server
authenticates with `SUBSTACK_SESSION_TOKEN` in a header. In principle equivalent, but unverified
through `SubstackApi` — this is the first validation step in implementation, not a settled fact.

## The key design consequence

Substack's server-side fetch only works for URLs already in its **own** S3 bucket; an arbitrary
external URL is rejected with 400. The chosen interface is **"remote URL only"** (`upload_image({url})`).
So the shortcut is unavailable for our use case: **the tool must download the external image itself
and re-encode it as a data URI**, then send that. This is the whole reason the tool has a
download-and-encode step rather than passing the URL straight through.

## Interface

A new tool `upload_image`, following the one-file-per-tool pattern: `src/tools/upload_image.js`
plus one entry in the `tools` registry in `src/server.js`. Nothing else.

```
upload_image({
  url:      string   // the external image URL to fetch and upload (required)
  post_id?: number   // optional; mirrors the dashboard's `postId`. Accepted by the API (measured).
                     // Effect is unconfirmed — include because it is a real key, not invented.
})
  → { id, url, content_type, bytes, width, height }
```

- `z.strictObject` (an unknown key is reported, never stripped — the only repair signal an LLM gets).
- The output `url` field's description states explicitly that it goes into `image2.src` of
  `set_post_body`. That description is the only way a model links the two tools without guessing.

## Flow and guards

The tool does three things: fetch the external image, validate it, upload it as a data URI.

1. **Fetch the URL.** This is a fetch of a model-chosen URL whose bytes we then re-emit — an
   exfiltration/SSRF channel if unguarded. Guards, in order:
   - **Scheme:** only `http`/`https`. Reject anything else (`file:`, `data:`, `gopher:`, …) up front.
   - **SSRF, after DNS resolution, not on the URL string.** Resolve the host and reject loopback,
     private (RFC 1918), and link-local (incl. `169.254.169.254`) addresses. Checking the string
     does not stop a hostname that resolves to `127.0.0.1`. This is the guard that matters most.
     The SSRF probes were deliberately **not** fired at Substack during measurement — running them
     would have performed the attack, not tested it; that they must be blocked is a requirement of
     *our* fetch, which is the one now doing arbitrary external downloads.
   - **Size cap on the downloaded bytes.** Our defense of this server's memory: the buffer plus its
     base64 string (~1.37×) are held in RAM. **Proposed 10 MB.** This is explicitly **not** Substack's
     limit — the bundle has a `MAX_FILE_SIZE` constant whose value could not be extracted from the
     minified source. We cap for our own safety and let Substack reject anything that passes ours but
     not its.
2. **Validate the content.** `content-type` must be `image/*`. Reject **HEIC** early with a message to
   convert to JPG/PNG — the dashboard itself refuses HEIC client-side. Substack also validates
   server-side (the `text/plain` → 400 above), so this is defense-in-depth and a better message, not
   the only check.
3. **Encode and upload.** Build `data:<content-type>;base64,<bytes>` and call
   `SubstackApi.uploadImage({image, post_id})`.

## API layer

Add `SubstackApi.uploadImage({image, post_id})` next to the other methods:

```js
async uploadImage({image, post_id = null}) {
  return this.request({
    method: 'POST',
    path: '/image',
    body: post_id === null ? {image} : {image, postId: post_id},
    referer: '/publish/post',
  });
}
```

No change to `requestUrl`: it already serializes any non-null body as JSON with
`Content-Type: application/json`, and the data URI is just a (large) JSON string value. `post_id` maps
to the API's `postId`; an absent one must not be sent as null (same rule as every other partial body
in this server).

## Logging

An upload is a write this server cannot undo, so it follows the existing rule: log intent at `info`
**before** the request.

- `upload_image.fetching` — the source `url`, before the download.
- `upload_image.uploading` — `content_type` and `bytes`, before the `POST`.
- The **data URI must never be logged.** It is hundreds of KB of base64 that would bury the session.
  This is the one deliberate exception to "post content is not truncated", and the exception is
  written at the call site so it is not mistaken for an oversight. Pass the metadata, not the payload.

## Testing

All outbound HTTP mocked with MSW, on **both** sides: the external image source and the Substack
`/image` endpoint. The cases that carry weight, each broken on purpose before being trusted:

- The Substack request body leaves as a **data URI**, not multipart or form-urlencoded.
- A non-image `content-type` from the source is rejected **before** the upload call is made.
- A URL whose host resolves to a private/loopback/link-local address is rejected (SSRF guard).
- A download exceeding the size cap is rejected before encoding.
- `http`/`https` only: a `file:`/`data:` scheme is rejected up front.
- On success the Substack `url` is returned to the caller as `url`, with `post_id` mapped to `postId`
  when present and omitted when absent.

MSW's `onUnhandledRequest: 'error'` stays on; build overrides with typed handlers so requests are
recorded in `msw.requests`.

## Documentation to correct

- `CLAUDE.md`: rewrite the "Images can be referenced but not uploaded" paragraph and the
  "Do not implement an upload" instruction with the measured facts above — including *why* the three
  earlier encodings failed (the data-URI shape), which is the reusable part. Note the external-URL
  rejection and the resulting download-and-encode design. Record the auth caveat as the open item.
- `README.md:143`: update the "An image must already be hosted by Substack" line to point at
  `upload_image`.

## Out of scope (stated so it is not re-litigated)

- **Guarding `image2.src` in `document.js`.** Today any string is accepted and an external URL saves,
  returns 200 and silently fails to render. This work makes that guard *more* sensible — there is now
  a legitimate way to obtain a valid `src` — but it remains a separate change.
- **Local-file and data-URI sources.** The interface is remote-URL-only by decision (2026-08-08): no
  filesystem access (path-traversal surface; would not work in the Docker image), and no caller-passed
  data URI (tens of KB of base64 spent in the model's context).
- **Confirming the auth path via header token** is implementation's first step, listed here as the one
  unproven fact — not a scope item to design away.
