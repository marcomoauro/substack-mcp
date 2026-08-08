# Draft settings — design

**Date:** 2026-08-08
**Status:** approved, ready for a plan
**Supersedes:** `update_draft`'s three-field surface (`draft_title`, `draft_subtitle`, `audience`)
and the `README.md:173` summary "Change a draft's title, subtitle or audience".

## Why this exists

The draft editor's **Post settings** panel holds nine settings. `update_draft` reaches exactly one of
them — `audience` — and reaches it wrongly: its enum is `everyone | only_paid | founding`, which
refuses `only_free`, a value the API accepts and the panel offers. So the cover image, the social
preview, the SEO fields, the comment permissions and the comment sort had no route through this
server at all, and one legal audience was unreachable.

## What was measured

Live on `implementing.substack.com`, 2026-08-08, from the authenticated dashboard. Two phases.

**Phase 1 — the panel, read-only.** The settings modal's controls are real `<input>` elements
carrying `name` and `value`, so the option sets were read off the DOM rather than inferred:
`audience` = `everyone | only_paid | only_free`, `commentLevel` = `everyone | subscribers |
only_paid | none`, `commentSort` = `best_first | most_recent_first | oldest_first`. The UI names
(`commentLevel`, `commentSort`) are **not** the wire names.

An XHR/fetch/`sendBeacon` interceptor was installed to capture what each control would send. It
captured nothing: the panel defers its save to the editor's autosave loop, which the interceptor
swallowed. `draft_updated_at` on the real draft was unchanged afterwards, confirming no write
escaped — so the wire names came from phase 2 instead, not from the panel.

**Phase 2 — writability, on a throwaway draft** created and deleted for the purpose. Each candidate
field was sent as a single-key `PUT /api/v1/drafts/:id`, then read back with a `GET` and compared.

Writable, value stored verbatim:

| Field | Panel control | Values |
|---|---|---|
| `audience` | Audience | `everyone`, `only_paid`, `only_free`, `founding` |
| `write_comment_permissions` | Allow comments from… | `everyone`, `subscribers`, `only_paid`, `none` |
| `default_comment_sort` | Order comments by… | `best_first`, `most_recent_first`, `oldest_first` |
| `cover_image` | Social preview → Image | any string (see below) |
| `social_title` | Social preview → Title | string |
| `description` | Social preview → Description | string |
| `search_engine_title` | SEO Options → SEO title | string |
| `search_engine_description` | SEO Options → SEO description | string |
| `slug` | SEO Options → Post URL | string |

`founding` is accepted by the API although the panel does not offer it. `only_free` is accepted and
is what today's enum wrongly refuses.

Also writable but outside the panel, and deliberately **not** exposed (see Scope): `should_send_email`,
`should_send_free_preview`, `explicit`, `hide_from_feed`, `show_guest_bios`,
`exempt_from_archive_paywall`, `meter_type` (only `none` and `metered`; every other value 400s),
`podcast_description`, `draft_section_id`.

### Three measured traps

**1. Six fields answer 200 and change nothing.** `postSchedules`, `language`, `email_from_name`,
`is_draft_hidden`, `ai_detection_disabled` and `free_unlock_required` were each sent, each answered
200, and each read back at its old value. This is the same silent-ignore family as `columnView`, the
export's dropped columns, `get_analytics`'s unexpected params and `get_post_stats`'s `order_by`.
`postSchedules` is the dangerous one: scheduling looks settable through the draft and is not.

**2. Validation is asymmetric, and the worst case is the one we most need to guard.** A bad
`audience`, `default_comment_sort` or `meter_type` answers 400 naming the parameter and its value.
A bad `write_comment_permissions` answers `{"error":"Something went wrong","type":"single"}` — no
field name, no valid set. A bad `draft_section_id` answers 400 `"Section not found"`. So for
`write_comment_permissions` a client-side enum is the only diagnosis a caller will ever get.

**3. `cover_image` has no server-side validation whatsoever.** The literal string
`"not-a-url-at-all"` was accepted with a 200 and stored. An external (Wikimedia) URL was likewise
stored verbatim. Substack will not tell a caller that its cover cannot render — which is exactly the
failure mode `CLAUDE.md` records for the fork's external `logo_url`/`photo_url`. The only possible
guard is ours.

## Scope

**In:** the nine panel fields, on `update_draft`.

**Out, by decision:**

- The extra writable fields listed above. The panel is the boundary; it keeps the surface closed and
  fully verified.
- `should_send_email` in particular. `publish_draft` already PUTs it as the publish intent, and it is
  the one flag in this server that can mail the entire list. A second door onto it buys convenience
  and risks the irreversible.
- Scheduling. It is not reachable through this endpoint at all (trap 1) and needs its own.
- `draft_section_id`. The server validates the id, but `implementing.substack.com` has no sections,
  so the success path cannot be verified here. Unverified writes do not ship.

## Design

### One tool, not two

The fields go on `update_draft`. A separate `set_draft_settings` would put `audience` on two tools,
and this repo has already rejected that shape once — two doors to the same data is the argument that
keeps `email_stats` out of `ANALYTICS_REPORTS`. `update_draft` is already the partial-write door onto
a draft; these are partial writes onto a draft.

Cost: the published schema grows from 3 settable fields to 11 — 12 keys counting `draft_id` — which
is roughly 3 KB on `tools/list`. Against `set_post_body`'s 21 KB that is not a consideration.

### The image pipeline becomes shared

`cover_image` must accept an external URL and re-host it, which means `update_draft` needs the
download-and-encode pipeline that currently lives as module-private functions inside
`src/tools/upload_image.js`. It moves to **`src/api/substack/image.js`**, a sibling of `csv.js`,
`document.js` and `comment.js` — where this repo already keeps shared building blocks:

- `MAX_IMAGE_BYTES`, `HEIC_TYPES`, `FETCH_TIMEOUT_MS`
- `isPrivateAddress`, `embeddedIpv4`, `assertPublicUrl`, `fetchGuarded`, `readCapped`
- one entry point `fetchImageAsDataUri(url, {lookup, fetchImpl})` → `{image, contentType, bytes}`

Error messages lose the `upload_image:` prefix for a neutral `image:`. Without that change
`update_draft` would report failures signed by a tool the caller never invoked. This costs no spec
churn: `upload_image.spec.js` asserts only on message fragments (`/not an image/`,
`/HEIC is not accepted/`, `/only http and https/`, `/over the .* limit/`), never on the prefix.
`isPrivateAddress` is imported directly by that spec, so `upload_image.js` re-exports it.

`upload_image.js` keeps its schema and handler and becomes a thin tool over the shared module.

### cover_image: pass through or re-host

A URL whose host is `substack-post-media.s3.amazonaws.com` or `substackcdn.com` is already
Substack-hosted and is forwarded unchanged. This is the case that matters in practice: a cover read
back from `get_draft` or `list_posts` arrives as one of those two hosts, and re-hosting it would
upload a duplicate of an asset Substack already serves.

Any other host is downloaded through `fetchImageAsDataUri` and uploaded via `POST /api/v1/image`,
and the returned S3 URL is what gets written. Substack server-fetches only its own bucket — an
external URL passed as `image` answers `400 "Failed to fetch image"` — so re-hosting is the only way
an external cover can work.

### Order of operations

Re-host first, then **one** PUT carrying every field. If the download or the upload fails, the PUT
never runs. A cover-image failure must not leave the other eight fields half-written, and a single
PUT is also what makes the whole call atomic from Substack's side.

The result reports `updated_fields` and, when a re-host happened, the `cover_image` that actually
landed — otherwise the caller has no way to learn the URL it now points at. This is the same reason
`set_post_body` returns a node tally rather than `'OK'`.

### Error handling

- The existing "no fields to update" guard stays, but its message currently lists three field names
  by hand. At eleven that list rots the first time a field is added, so it is derived from
  `Object.keys(updateDraftSchema.shape)` minus `draft_id`.
- `write_comment_permissions` is an enum because Substack's own rejection names nothing (trap 2).
- The six silently-ignored fields stay off the schema. `strictObject` already rejects them, and the
  value of that rejection is that it *tells* the model the key does not exist rather than letting it
  believe it scheduled a post.

## Testing

MSW handlers for `PUT /drafts/:id`, `POST /api/v1/image` and the external image fetch. The
assertions that carry weight:

- each field reaches the PUT body under its wire name
- `only_free` is accepted — the regression today's enum has
- a cover already on a Substack host produces **no** call to `/api/v1/image`
- an external cover produces the upload *then* the PUT, with the S3 URL in the body
- a failed re-host leaves `msw.requests` with no PUT at all
- `strictObject` rejects `postSchedules` and `language`, with a comment recording the measurement
- the no-fields message names every field, derived rather than literal

Every new assertion gets broken on purpose before it is trusted, with a grep confirming the mutation
landed — the repo rule that has already caught three vacuous tests.

## Documentation

`CLAUDE.md` gains the measured facts: the nine writable panel fields with their wire names, the six
silent-ignores (bringing that count to seven distinct instances in this API), the asymmetric
validation, and the note that `cover_image` is unvalidated server-side. `README.md:173` stops saying
"title, subtitle or audience".
