import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isSubstackHosted, readImageFileAsDataUri, MAX_IMAGE_BYTES} from './image.js';

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

// A local file has no Content-Type header, so the type has to come from the bytes. These are the
// real signatures, not approximations: a `.png` that is actually a PDF must be caught here rather
// than at Substack, which answers a 400 that names neither the file nor the reason.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
// RIFF....WEBP — the four size bytes at offset 4 are part of the container, not of the signature.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
// An ISO-BMFF box: size, `ftyp`, then the brand. `heic` is what an iPhone writes.
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(16)]);

describe('readImageFileAsDataUri', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'substack-mcp-image-'));
  });
  after(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  // Written with a deliberately wrong extension throughout: the type must come from the bytes.
  const write = async (name, bytes) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };

  test('reads a PNG and returns it as a data URI', async () => {
    const file = await write('cover.png', PNG);
    const result = await readImageFileAsDataUri(file);

    assert.equal(result.contentType, 'image/png');
    assert.equal(result.bytes, PNG.byteLength);
    assert.equal(result.image, `data:image/png;base64,${PNG.toString('base64')}`);
  });

  test('sniffs JPEG, GIF and WebP from their signatures, not the extension', async () => {
    // Every one of these is named `.png` on purpose.
    assert.equal((await readImageFileAsDataUri(await write('a.png', JPEG))).contentType, 'image/jpeg');
    assert.equal((await readImageFileAsDataUri(await write('b.png', GIF))).contentType, 'image/gif');
    assert.equal((await readImageFileAsDataUri(await write('c.png', WEBP))).contentType, 'image/webp');
  });

  test('rejects HEIC with the same convert-first message the URL path gives', async () => {
    const file = await write('photo.heic', HEIC);
    await assert.rejects(readImageFileAsDataUri(file), /HEIC is not accepted/);
  });

  // The whole point of sniffing: a PDF renamed to .png would otherwise reach Substack.
  test('rejects an unrecognised format and names the bytes it found', async () => {
    const file = await write('fake.png', PDF);
    await assert.rejects(readImageFileAsDataUri(file), /unrecognised image format.*25 50 44 46/s);
  });

  test('rejects a file too short to carry any signature', async () => {
    const file = await write('tiny.png', Buffer.from([0x89, 0x50]));
    await assert.rejects(readImageFileAsDataUri(file), /unrecognised image format/);
  });

  // A relative path resolves against the server process's cwd, which is not the caller's. Accepting
  // one would read the wrong file, or none, and neither failure would say why.
  test('rejects a relative path', async () => {
    await assert.rejects(readImageFileAsDataUri('assets/cover.png'), /must be absolute/);
  });

  test('rejects a directory', async () => {
    await assert.rejects(readImageFileAsDataUri(dir), /not a regular file/);
  });

  test('reports a missing file by path instead of leaking an ENOENT stack', async () => {
    await assert.rejects(readImageFileAsDataUri(path.join(dir, 'nope.png')), /no such file/);
  });

  test('follows a symlink to a real image', async () => {
    const target = await write('real.png', PNG);
    const link = path.join(dir, 'link.png');
    await fs.symlink(target, link);

    assert.equal((await readImageFileAsDataUri(link)).contentType, 'image/png');
  });

  test('rejects a file over the byte cap using its size, before reading it', async () => {
    const file = await write('big.png', Buffer.concat([PNG, Buffer.alloc(100)]));
    await assert.rejects(
      readImageFileAsDataUri(file, {maxBytes: 10}),
      /over the 10-byte limit/
    );
  });

  test('accepts a file exactly at the cap', async () => {
    const file = await write('atlimit.png', PNG);
    const result = await readImageFileAsDataUri(file, {maxBytes: PNG.byteLength});
    assert.equal(result.bytes, PNG.byteLength);
  });

  test('defaults the cap to MAX_IMAGE_BYTES', async () => {
    const file = await write('default.png', PNG);
    assert.ok(MAX_IMAGE_BYTES > PNG.byteLength);
    assert.equal((await readImageFileAsDataUri(file)).bytes, PNG.byteLength);
  });
});
