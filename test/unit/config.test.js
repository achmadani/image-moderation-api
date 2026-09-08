'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

/**
 * config.js is a validated singleton, so each case runs in its own process.
 * Returns either the parsed config or the thrown validation message.
 */
function loadConfig(env) {
  const script = `
    try {
      const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});
      process.stdout.write(JSON.stringify({ ok: true, config: c }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, message: e.message }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      // A valid baseline; each test overrides only what it is exercising.
      NODE_ENV: 'test',
      MODEL_PATH: path.join(ROOT, 'model'),
      API_KEYS: 'a-valid-key-0123456789',
      ...env,
    },
  });
  return JSON.parse(out);
}

test('a valid environment produces the documented defaults', () => {
  const { ok, config } = loadConfig({});
  assert.strictEqual(ok, true);
  assert.strictEqual(config.port, 3000);
  assert.strictEqual(config.host, '0.0.0.0');
  assert.strictEqual(config.thresholdBlock, 0.7);
  assert.strictEqual(config.thresholdReview, 0.4);
  assert.strictEqual(config.sexyWeight, 0.5);
  assert.strictEqual(config.maxUploadBytes, 10485760);
  assert.strictEqual(config.maxImagePixels, 50000000);
  assert.strictEqual(config.maxBatchSize, 10);
  assert.strictEqual(config.workerPoolSize, 2);
  assert.strictEqual(config.inferenceTimeoutMs, 15000);
  assert.strictEqual(config.rateLimitMax, 60);
  assert.strictEqual(config.modelVersion, 'nsfwjs-mobilenet-v2');
  assert.deepStrictEqual(config.allowedMime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);
});

test('AUTH_ENABLED=true without API_KEYS fails at startup', () => {
  const { ok, message } = loadConfig({ API_KEYS: '' });
  assert.strictEqual(ok, false);
  assert.match(message, /API_KEYS must contain at least one key/);
});

test('AUTH_ENABLED=false makes API_KEYS optional', () => {
  const { ok, config } = loadConfig({ API_KEYS: '', AUTH_ENABLED: 'false' });
  assert.strictEqual(ok, true);
  assert.strictEqual(config.authEnabled, false);
});

test('a short API key is rejected', () => {
  const { ok, message } = loadConfig({ API_KEYS: 'short' });
  assert.strictEqual(ok, false);
  assert.match(message, /shorter than 16 characters/);
});

test('THRESHOLD_BLOCK below THRESHOLD_REVIEW fails', () => {
  const { ok, message } = loadConfig({ THRESHOLD_BLOCK: '0.3', THRESHOLD_REVIEW: '0.6' });
  assert.strictEqual(ok, false);
  assert.match(message, /THRESHOLD_BLOCK \(0\.3\) must be >= THRESHOLD_REVIEW \(0\.6\)/);
});

test('a missing model directory fails fast rather than at first request', () => {
  const { ok, message } = loadConfig({ MODEL_PATH: '/nonexistent/model/dir' });
  assert.strictEqual(ok, false);
  assert.match(message, /does not contain model\.json/);
  assert.match(message, /baked into the image/);
});

test('out-of-range numbers are rejected with the bound in the message', () => {
  const cases = [
    [{ PORT: '99999' }, /PORT must be <= 65535/],
    [{ THRESHOLD_BLOCK: '1.5' }, /THRESHOLD_BLOCK must be <= 1/],
    [{ SEXY_WEIGHT: '-1' }, /SEXY_WEIGHT must be >= 0/],
    [{ WORKER_POOL_SIZE: '0' }, /WORKER_POOL_SIZE must be >= 1/],
    [{ MAX_BATCH_SIZE: '500' }, /MAX_BATCH_SIZE must be <= 100/],
  ];
  for (const [env, pattern] of cases) {
    const { ok, message } = loadConfig(env);
    assert.strictEqual(ok, false, `${JSON.stringify(env)} should fail`);
    assert.match(message, pattern);
  }
});

test('non-numeric and non-boolean values are rejected', () => {
  assert.match(loadConfig({ PORT: 'abc' }).message, /PORT must be a number/);
  assert.match(loadConfig({ WORKER_POOL_SIZE: '2.5' }).message, /WORKER_POOL_SIZE must be an integer/);
  assert.match(loadConfig({ AUTH_ENABLED: 'maybe' }).message, /AUTH_ENABLED must be a boolean/);
  assert.match(loadConfig({ LOG_LEVEL: 'loud' }).message, /LOG_LEVEL must be one of/);
});

test('every validation problem is reported at once, not one per restart', () => {
  const { ok, message } = loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud', API_KEYS: 'short' });
  assert.strictEqual(ok, false);
  assert.match(message, /PORT must be a number/);
  assert.match(message, /LOG_LEVEL must be one of/);
  assert.match(message, /shorter than 16 characters/);
});

test('an undetectable MIME type in ALLOWED_MIME is rejected', () => {
  const { ok, message } = loadConfig({ ALLOWED_MIME: 'image/jpeg,image/heic' });
  assert.strictEqual(ok, false);
  assert.match(message, /image\/heic.*cannot detect from magic bytes/);
});

test('URL_ALLOWLIST entries must be bare hostnames', () => {
  const { ok, message } = loadConfig({ URL_ALLOWLIST: 'https://cdn.example.com' });
  assert.strictEqual(ok, false);
  assert.match(message, /bare hostnames without scheme or port/);
});

test('CACHE_ENABLED with a non-redis URL is rejected', () => {
  const { ok, message } = loadConfig({ CACHE_ENABLED: 'true', REDIS_URL: 'http://localhost:6379' });
  assert.strictEqual(ok, false);
  assert.match(message, /REDIS_URL must start with redis/);
});

test('boolean values accept the usual spellings', () => {
  for (const v of ['true', '1', 'yes', 'on']) {
    assert.strictEqual(loadConfig({ METRICS_ENABLED: v }).config.metricsEnabled, true, v);
  }
  for (const v of ['false', '0', 'no', 'off']) {
    assert.strictEqual(loadConfig({ METRICS_ENABLED: v }).config.metricsEnabled, false, v);
  }
});
