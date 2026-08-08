import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {http, HttpResponse} from 'msw';
import {uploadImageHandler, uploadImageSchema, MAX_IMAGE_BYTES, isPrivateAddress} from './upload_image.js';
import {createMswServer, IMAGE_URL, IMAGE_UPLOAD_RESPONSE} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';

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
