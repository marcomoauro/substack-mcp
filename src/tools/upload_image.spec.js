import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
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

describe('uploadImageHandler — local file source', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'substack-mcp-upload-'));
  });
  after(async () => fs.rm(dir, {recursive: true, force: true}));

  const writeFile = async (name, bytes) => {
    const file = nodePath.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };

  test('reads a local file and uploads it as a data URI, with no outbound download', async () => {
    const file = await writeFile('cover.png', PNG);
    // No source handler is registered: MSW runs with onUnhandledRequest 'error', so any attempt to
    // fetch a URL here would fail the test rather than pass silently.
    const result = await run({path: file});

    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.equal(upload.body.image, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(result.url, IMAGE_UPLOAD_RESPONSE.url);
  });

  test('forwards post_id for a local file too', async () => {
    const file = await writeFile('with-post.png', PNG);
    await run({path: file, post_id: 42});
    const upload = msw.requests.find((r) => r.url.endsWith('/api/v1/image'));
    assert.equal(upload.body.postId, 42);
  });

  test('does not upload when the file is not a recognised image', async () => {
    const file = await writeFile('fake.png', Buffer.from('%PDF-1.4 not an image at all'));
    await assert.rejects(run({path: file}), /unrecognised image format/);
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });

  // The intent line goes out BEFORE the read, so a failing read still leaves a record of which file
  // was attempted — the mirror of `upload_image.fetching` on the URL branch. Size and type are only
  // known afterwards and belong to `upload_image.uploading`, which both branches share.
  test('logs which file it is about to read, then the size and type, never the base64', async () => {
    const body = Buffer.concat([PNG, Buffer.alloc(5000, 0xab)]);
    const file = await writeFile('logged.png', body);
    const payload = body.toString('base64');

    const logs = await captureLogs(() => run({path: file}));
    const reading = logs.find((l) => l.msg === 'upload_image.reading');
    const uploading = logs.find((l) => l.msg === 'upload_image.uploading');

    assert.ok(reading, 'expected an upload_image.reading line');
    assert.equal(reading.path, file);
    assert.equal(uploading.bytes, body.byteLength);
    assert.equal(uploading.content_type, 'image/png');
    // Not the tool's line, not the API layer's request line either.
    assert.equal(JSON.stringify(logs).includes(payload), false);
    assert.ok(logs.some((l) => l.msg === 'substack.request'));
  });

  test('logs the attempted path even when the read fails', async () => {
    const missing = nodePath.join(dir, 'gone.png');
    const logs = await captureLogs(() => run({path: missing}).catch(() => {}));
    const reading = logs.find((l) => l.msg === 'upload_image.reading');

    assert.equal(reading?.path, missing);
  });
});

// A `.refine()` does not survive into the published JSON Schema, so the rule is also stated in both
// descriptions. These pin the runtime half of that pair.
describe('uploadImageSchema — url and path are exclusive', () => {
  test('rejects a call with neither', () => {
    assert.throws(() => uploadImageSchema.parse({}), /exactly one of/);
  });

  test('rejects a call with both', () => {
    assert.throws(
      () => uploadImageSchema.parse({url: 'https://example.com/a.png', path: '/tmp/a.png'}),
      /exactly one of/
    );
  });

  test('accepts either one alone', () => {
    assert.doesNotThrow(() => uploadImageSchema.parse({url: 'https://example.com/a.png'}));
    assert.doesNotThrow(() => uploadImageSchema.parse({path: '/tmp/a.png'}));
  });

  // strictObject still has to report an unknown key — the only repair signal an LLM gets.
  test('still reports an unrecognised key', () => {
    assert.throws(() => uploadImageSchema.parse({file: '/tmp/a.png'}), /Unrecognized key/);
  });
});

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

  test('rejects the HEIC -sequence variant too', async () => {
    msw.server.use(sourceHandler({type: 'image/heic-sequence'}));
    await assert.rejects(run({url: SOURCE}), /HEIC is not accepted/);
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });
});

describe('uploadImageHandler — redirect SSRF guard', () => {
  test('rejects a redirect to a private address without uploading', async () => {
    const REDIRECTOR = 'https://images.example.com/redirect.jpg';
    const INTERNAL = 'http://metadata.internal/latest';
    // First host resolves public, the redirect target resolves private.
    const lookup = async (hostname) =>
      hostname === 'metadata.internal'
        ? [{address: '169.254.169.254', family: 4}]
        : [{address: '93.184.216.34', family: 4}];
    msw.server.use(
      http.get(REDIRECTOR, () => new HttpResponse(null, {status: 302, headers: {Location: INTERNAL}}))
    );
    await assert.rejects(
      uploadImageHandler({url: REDIRECTOR}, {lookup, fetchImpl: fetch}),
      /private\/loopback/
    );
    assert.equal(msw.requests.find((r) => r.url.endsWith('/api/v1/image')), undefined);
  });
});

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

  // The URL parser compresses an IPv4-mapped host to hex, so the dotted-only check was an SSRF
  // hole: these are 169.254.169.254 and 127.0.0.1 in the form isPrivateAddress actually receives.
  test('flags an IPv4-mapped address written in the compressed hex form', () => {
    assert.equal(isPrivateAddress('::ffff:a9fe:a9fe', 6), true);
    assert.equal(isPrivateAddress('::ffff:7f00:1', 6), true);
    assert.equal(isPrivateAddress('::ffff:5db8:d822', 6), false); // 93.184.216.34, public
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

  test('de-brackets an IPv6 host before the lookup, and still guards it', async () => {
    let seenHost;
    const lookup = async (hostname) => { seenHost = hostname; return [{address: '::1', family: 6}]; };
    let fetched = false;
    const fetchImpl = async () => { fetched = true; return new HttpResponse(); };
    await assert.rejects(
      uploadImageHandler({url: 'http://[::1]/x.png'}, {lookup, fetchImpl}),
      /private\/loopback/
    );
    assert.equal(seenHost, '::1'); // de-bracketed, not '[::1]'
    assert.equal(fetched, false);
  });
});

describe('uploadImageHandler — redirect edge cases', () => {
  const publicOnly = async () => [{address: '93.184.216.34', family: 4}];

  test('rejects after too many redirects', async () => {
    let n = 0;
    const fetchImpl = async () =>
      new HttpResponse(null, {status: 302, headers: {Location: `https://images.example.com/n${n++}.jpg`}});
    await assert.rejects(
      uploadImageHandler({url: 'https://images.example.com/a.jpg'}, {lookup: publicOnly, fetchImpl}),
      /too many redirects/
    );
  });

  test('rejects a redirect with no Location header', async () => {
    const fetchImpl = async () => new HttpResponse(null, {status: 302});
    await assert.rejects(
      uploadImageHandler({url: 'https://images.example.com/a.jpg'}, {lookup: publicOnly, fetchImpl}),
      /no Location header/
    );
  });
});

describe('uploadImageHandler — Content-Length pre-check', () => {
  test('rejects a declared-oversize body before reading it', async () => {
    let read = false;
    const fetchImpl = async () => new Response('tiny', {
      status: 200,
      headers: {'Content-Type': 'image/png', 'Content-Length': String(MAX_IMAGE_BYTES + 1)},
    });
    // Wrap arrayBuffer so we can prove it was never called: the header alone must reject.
    const orig = fetchImpl;
    const spyingFetch = async (...a) => {
      const r = await orig(...a);
      const arrayBuffer = r.arrayBuffer.bind(r);
      r.arrayBuffer = (...x) => { read = true; return arrayBuffer(...x); };
      return r;
    };
    await assert.rejects(
      uploadImageHandler({url: 'https://images.example.com/a.png'}, {lookup: publicLookup, fetchImpl: spyingFetch}),
      /Content-Length.*over the .* limit/
    );
    assert.equal(read, false);
  });
});

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

describe('uploadImageHandler — logging', () => {
  test('logs intent before the request and never logs the data URI payload', async () => {
    const body = Buffer.alloc(5000, 0xab);
    const payload = body.toString('base64');
    msw.server.use(sourceHandler({body, type: 'image/png'}));

    // captureLogs returns the parsed log lines directly as an array, at debug level — where the
    // API layer logs the full request body, so this proves the data URI is elided end to end.
    const logs = await captureLogs(() => run({url: SOURCE}));
    const events = logs.map((l) => l.msg);

    assert.ok(events.includes('upload_image.fetching'));
    assert.ok(events.includes('upload_image.uploading'));
    // The base64 payload must never appear in any log line — not the tool's, not the API's.
    assert.equal(JSON.stringify(logs).includes(payload), false);
    // But the request line still exists (truncated), proving logging was elided, not dropped.
    assert.ok(logs.some((l) => l.msg === 'substack.request'));
  });
});
