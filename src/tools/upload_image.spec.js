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
