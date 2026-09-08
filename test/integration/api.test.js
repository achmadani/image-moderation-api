'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

// Configuration is read once when src/config is first required, so the whole
// environment for this file has to be in place before anything is imported.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MODEL_PATH = path.join(__dirname, '..', '..', 'model');
process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS = 'test-key-aaaaaaaaaaaaaaaa,second-key-bbbbbbbbbbbbb';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.CACHE_ENABLED = 'false';
process.env.METRICS_ENABLED = 'true';
process.env.WORKER_POOL_SIZE = '1';
process.env.MAX_UPLOAD_BYTES = '2000';
process.env.MAX_BATCH_SIZE = '3';
process.env.URL_FETCH_ENABLED = 'true';

const { build } = require('../../src/server');
const { buildFixtures } = require('../fixtures/generate');

const KEY = 'test-key-aaaaaaaaaaaaaaaa';
const SECOND_KEY = 'second-key-bbbbbbbbbbbbb';

let app;
let fx;

/** Minimal multipart/form-data encoder — avoids a test-only dependency. */
function multipart(files) {
  const boundary = '----imagemoderationtest0123456789';
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.contentType}\r\n\r\n`
    ));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (name, data, contentType = 'image/jpeg', field = 'image') =>
  multipart([{ field, filename: name, contentType, data }]);

test.before(async () => {
  fx = await buildFixtures();
  app = await build();
}, { timeout: 120000 });

test.after(async () => {
  if (!app) return;
  await app.close();
  await app.pool.destroy();
  await app.cache.close();
});

// ---------------------------------------------------------------------------
// health / ready / metrics
// ---------------------------------------------------------------------------
test('GET /health is 200 and needs no API key', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json().status, 'ok');
});

test('GET /ready is 200 once the pool has loaded the model', async () => {
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.status, 'ready');
  assert.strictEqual(body.workers.ready, 1);
});

test('GET /metrics exposes Prometheus text without an API key', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /moderation_worker_pool\{state="ready"/);
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
test('a request without X-API-Key is rejected with 401', async () => {
  const { payload, headers } = upload('a.jpg', fx['solid-red.jpg']);
  const res = await app.inject({ method: 'POST', url: '/v1/moderate', payload, headers });
  assert.strictEqual(res.statusCode, 401);
  const body = res.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  assert.ok(body.meta.requestId);
});

test('an unknown API key is rejected with 401', async () => {
  const { payload, headers } = upload('a.jpg', fx['solid-red.jpg']);
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload,
    headers: { ...headers, 'x-api-key': 'definitely-not-a-valid-key' },
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.json().error.code, 'UNAUTHORIZED');
});

test('any key in API_KEYS is accepted', async () => {
  const { payload, headers } = upload('a.jpg', fx['solid-red.jpg']);
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload,
    headers: { ...headers, 'x-api-key': SECOND_KEY },
  });
  assert.strictEqual(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// POST /v1/moderate
// ---------------------------------------------------------------------------
test('a valid upload returns the documented success envelope', async () => {
  const { payload, headers } = upload('a.jpg', fx['solid-red.jpg']);
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 200);

  const body = res.json();
  assert.strictEqual(body.success, true);
  assert.deepStrictEqual(Object.keys(body).sort(), ['data', 'meta', 'success']);
  assert.deepStrictEqual(Object.keys(body.data).sort(), ['image', 'nsfwScore', 'scores', 'topClass', 'verdict']);
  assert.deepStrictEqual(Object.keys(body.data.scores).sort(), ['drawing', 'hentai', 'neutral', 'porn', 'sexy']);
  assert.deepStrictEqual(Object.keys(body.data.image).sort(), ['bytes', 'format', 'hash', 'height', 'width']);
  assert.deepStrictEqual(Object.keys(body.meta).sort(), ['modelVersion', 'processingMs', 'requestId', 'thresholds']);

  assert.ok(['allow', 'review', 'block'].includes(body.data.verdict));
  assert.match(body.data.image.hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(body.data.image.width, 512);
  assert.strictEqual(body.data.image.height, 384);
  assert.strictEqual(body.data.image.format, 'jpeg');
  assert.strictEqual(body.data.image.bytes, fx['solid-red.jpg'].length);
  assert.strictEqual(body.meta.modelVersion, 'nsfwjs-mobilenet-v2');
  assert.deepStrictEqual(body.meta.thresholds, { block: 0.7, review: 0.4 });
  assert.ok(body.meta.processingMs > 0);
});

test('the same image always yields the same hash and verdict', async () => {
  const send = async () => {
    const { payload, headers } = upload('a.jpg', fx['solid-red.jpg']);
    return (await app.inject({ method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY } })).json();
  };
  const [a, b] = [await send(), await send()];
  assert.strictEqual(a.data.image.hash, b.data.image.hash);
  assert.deepStrictEqual(a.data.scores, b.data.scores);
  assert.notStrictEqual(a.meta.requestId, b.meta.requestId);
});

test('an upload above MAX_UPLOAD_BYTES is rejected with 413', async () => {
  const { payload, headers } = upload('big.png', fx['oversized.png'], 'image/png');
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(res.json().error.code, 'FILE_TOO_LARGE');
});

test('a non-image payload is rejected with 415 regardless of its declared type', async () => {
  // Declared image/jpeg and named .jpg, but the bytes are plain text.
  const { payload, headers } = upload('lies.jpg', fx['not-an-image.txt'], 'image/jpeg');
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 415);
  assert.strictEqual(res.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('a file with a valid header but corrupt body is rejected with 400', async () => {
  const { payload, headers } = upload('c.png', fx['corrupt.png'], 'image/png');
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'DECODE_FAILED');
});

test('multipart without an "image" field is rejected with 400', async () => {
  const { payload, headers } = upload('a.jpg', fx['solid-red.jpg'], 'image/jpeg', 'photo');
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'NO_IMAGE_PROVIDED');
});

test('base64 input is accepted and matches the multipart result', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { base64: fx['solid-red.jpg'].toString('base64') },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json().data.image.format, 'jpeg');
});

test('a data: URI prefix on base64 is tolerated', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { base64: `data:image/jpeg;base64,${fx['solid-red.jpg'].toString('base64')}` },
  });
  assert.strictEqual(res.statusCode, 200);
});

test('an empty JSON body reports NO_IMAGE_PROVIDED', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: {},
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'NO_IMAGE_PROVIDED');
});

test('supplying both url and base64 is rejected', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { url: 'http://example.com/a.jpg', base64: 'abc' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'INVALID_INPUT');
});

test('a url pointing at the host network is refused, not fetched', async () => {
  for (const url of ['http://127.0.0.1/x.jpg', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x.jpg']) {
    const res = await app.inject({
      method: 'POST', url: '/v1/moderate',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { url },
    });
    assert.strictEqual(res.statusCode, 422, `${url} should be refused`);
    assert.strictEqual(res.json().error.code, 'URL_FETCH_FAILED');
    assert.match(res.json().error.message, /private address/);
  }
});

test('a non-http scheme is rejected', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { url: 'file:///etc/passwd' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'INVALID_INPUT');
});

test('an unsupported request Content-Type is rejected with 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate',
    headers: { 'x-api-key': KEY, 'content-type': 'text/plain' },
    payload: 'hello',
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().error.code, 'INVALID_INPUT');
});

test('an unknown route returns the failure envelope, not an HTML error', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: { 'x-api-key': KEY } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.json().success, false);
});

// ---------------------------------------------------------------------------
// POST /v1/moderate/batch
// ---------------------------------------------------------------------------
test('a batch where some items fail still returns 200 with per-item errors', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate/batch',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: {
      images: [
        { id: 'good', base64: fx['solid-red.jpg'].toString('base64') },
        { id: 'not-an-image', base64: fx['not-an-image.txt'].toString('base64') },
        { id: 'blocked-url', url: 'http://127.0.0.1/x.jpg' },
      ],
    },
  });

  assert.strictEqual(res.statusCode, 200, 'a valid batch request must always be 200');
  const body = res.json();
  assert.strictEqual(body.success, true);
  assert.deepStrictEqual(body.data.summary, { total: 3, succeeded: 1, failed: 2 });

  const [ok, badImage, badUrl] = body.data.results;

  assert.strictEqual(ok.index, 0);
  assert.strictEqual(ok.id, 'good');
  assert.strictEqual(ok.success, true);
  assert.ok(['allow', 'review', 'block'].includes(ok.data.verdict));
  assert.match(ok.data.image.hash, /^[0-9a-f]{64}$/);

  assert.strictEqual(badImage.success, false);
  assert.strictEqual(badImage.id, 'not-an-image');
  assert.strictEqual(badImage.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.strictEqual(badImage.data, undefined);

  assert.strictEqual(badUrl.success, false);
  assert.strictEqual(badUrl.error.code, 'URL_FETCH_FAILED');
});

test('a batch of multipart files is accepted', async () => {
  const { payload, headers } = multipart([
    { field: 'image', filename: 'a.jpg', contentType: 'image/jpeg', data: fx['solid-red.jpg'] },
    { field: 'image', filename: 'b.png', contentType: 'image/png', data: fx['tiny.png'] },
  ]);
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate/batch', payload, headers: { ...headers, 'x-api-key': KEY },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json().data.summary, { total: 2, succeeded: 2, failed: 0 });
});

test('a batch above MAX_BATCH_SIZE is rejected with 413', async () => {
  const one = { base64: fx['tiny.png'].toString('base64') };
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate/batch',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { images: [one, one, one, one] },
  });
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(res.json().error.code, 'BATCH_TOO_LARGE');
});

test('a batch with an empty or missing images array is rejected', async () => {
  const empty = await app.inject({
    method: 'POST', url: '/v1/moderate/batch',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { images: [] },
  });
  assert.strictEqual(empty.statusCode, 400);
  assert.strictEqual(empty.json().error.code, 'NO_IMAGE_PROVIDED');

  const missing = await app.inject({
    method: 'POST', url: '/v1/moderate/batch',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    payload: { notImages: [] },
  });
  assert.strictEqual(missing.statusCode, 400);
  assert.strictEqual(missing.json().error.code, 'INVALID_INPUT');
});

test('the batch endpoint also requires an API key', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/moderate/batch',
    headers: { 'content-type': 'application/json' },
    payload: { images: [{ base64: fx['tiny.png'].toString('base64') }] },
  });
  assert.strictEqual(res.statusCode, 401);
});
