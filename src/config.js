'use strict';

const fs = require('fs');
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config({ quiet: true }); } catch { /* dotenv is optional at runtime */ }
}

const problems = [];
const env = process.env;

function present(name) {
  const v = env[name];
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function str(name, def) {
  return present(name) ? String(env[name]).trim() : def;
}

function enumStr(name, def, allowed) {
  const v = str(name, def);
  if (!allowed.includes(v)) {
    problems.push(`${name} must be one of ${allowed.join('|')} (got "${v}")`);
  }
  return v;
}

function num(name, def, { min, max, integer }) {
  if (!present(name)) return def;
  const v = Number(env[name]);
  if (!Number.isFinite(v)) {
    problems.push(`${name} must be a number (got "${env[name]}")`);
    return def;
  }
  if (integer && !Number.isInteger(v)) {
    problems.push(`${name} must be an integer (got "${env[name]}")`);
    return def;
  }
  if (min !== undefined && v < min) problems.push(`${name} must be >= ${min} (got ${v})`);
  if (max !== undefined && v > max) problems.push(`${name} must be <= ${max} (got ${v})`);
  return v;
}

const int = (name, def, range = {}) => num(name, def, { ...range, integer: true });
const float = (name, def, range = {}) => num(name, def, range);

function bool(name, def) {
  if (!present(name)) return def;
  const v = String(env[name]).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be a boolean (true/false), got "${env[name]}"`);
  return def;
}

function list(name, def) {
  if (!present(name)) return def;
  return String(env[name]).split(',').map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = enumStr('NODE_ENV', 'development', ['development', 'test', 'staging', 'production']);
const logLevel = enumStr('LOG_LEVEL', 'info', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const authEnabled = bool('AUTH_ENABLED', true);
const apiKeys = list('API_KEYS', []);
if (authEnabled && apiKeys.length === 0) {
  problems.push('API_KEYS must contain at least one key when AUTH_ENABLED=true');
}
for (const key of apiKeys) {
  if (key.length < 16) problems.push(`API_KEYS contains a key shorter than 16 characters ("${key.slice(0, 4)}…")`);
}

const thresholdBlock = float('THRESHOLD_BLOCK', 0.7, { min: 0, max: 1 });
const thresholdReview = float('THRESHOLD_REVIEW', 0.4, { min: 0, max: 1 });
if (thresholdBlock < thresholdReview) {
  problems.push(`THRESHOLD_BLOCK (${thresholdBlock}) must be >= THRESHOLD_REVIEW (${thresholdReview})`);
}

const modelPath = str('MODEL_PATH', path.join(__dirname, '..', 'model'));
const modelJsonPath = path.join(modelPath, 'model.json');
if (!fs.existsSync(modelJsonPath)) {
  problems.push(`MODEL_PATH does not contain model.json (looked for ${modelJsonPath}) — the model must be baked into the image, not downloaded at runtime`);
}

const allowedMime = list('ALLOWED_MIME', ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);
const KNOWN_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/tiff']);
for (const m of allowedMime) {
  if (!KNOWN_MIME.has(m)) problems.push(`ALLOWED_MIME contains "${m}", which this service cannot detect from magic bytes`);
}

const urlFetchEnabled = bool('URL_FETCH_ENABLED', true);
const urlAllowlist = list('URL_ALLOWLIST', []);
for (const host of urlAllowlist) {
  if (/[/:]/.test(host)) problems.push(`URL_ALLOWLIST entries must be bare hostnames without scheme or port (got "${host}")`);
}

const cacheEnabled = bool('CACHE_ENABLED', false);
const redisUrl = str('REDIS_URL', 'redis://localhost:6379');
if (cacheEnabled && !/^rediss?:\/\//.test(redisUrl)) {
  problems.push(`REDIS_URL must start with redis:// or rediss:// when CACHE_ENABLED=true (got "${redisUrl}")`);
}

const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  host: str('HOST', '0.0.0.0'),
  logLevel,
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30000, { min: 1000 }),
  // Window between /ready flipping to 503 and the listener closing, so nginx
  // sees an unhealthy service instead of a refused connection. 0 disables it.
  shutdownDrainMs: int('SHUTDOWN_DRAIN_MS', 3000, { min: 0, max: 60000 }),

  authEnabled,
  apiKeys: Object.freeze(apiKeys),

  modelPath,
  modelJsonPath,
  modelVersion: 'nsfwjs-mobilenet-v2',
  thresholdBlock,
  thresholdReview,
  sexyWeight: float('SEXY_WEIGHT', 0.5, { min: 0, max: 1 }),

  maxUploadBytes: int('MAX_UPLOAD_BYTES', 10485760, { min: 1024 }),
  maxImagePixels: int('MAX_IMAGE_PIXELS', 50000000, { min: 1024 }),
  maxBatchSize: int('MAX_BATCH_SIZE', 10, { min: 1, max: 100 }),
  allowedMime: Object.freeze(allowedMime),

  urlFetchEnabled,
  urlFetchTimeoutMs: int('URL_FETCH_TIMEOUT_MS', 8000, { min: 100 }),
  urlAllowlist: Object.freeze(urlAllowlist),

  workerPoolSize: int('WORKER_POOL_SIZE', 2, { min: 1, max: 16 }),
  inferenceTimeoutMs: int('INFERENCE_TIMEOUT_MS', 15000, { min: 100 }),
  maxConcurrentRequests: int('MAX_CONCURRENT_REQUESTS', 20, { min: 1 }),

  rateLimitEnabled: bool('RATE_LIMIT_ENABLED', true),
  rateLimitMax: int('RATE_LIMIT_MAX', 60, { min: 1 }),
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60000, { min: 1000 }),

  metricsEnabled: bool('METRICS_ENABLED', true),
  storeImageHash: bool('STORE_IMAGE_HASH', true),

  cacheEnabled,
  redisUrl,
  cacheTtlSeconds: int('CACHE_TTL_SECONDS', 86400, { min: 1 }),

  // Optional TF tuning: keeps N workers from each spawning a full thread pool
  // on a shared home server. Defaults are derived from the pool size.
  tfIntraOpThreads: int('TF_NUM_INTRAOP_THREADS', 0, { min: 0, max: 64 }),
  tfInterOpThreads: int('TF_NUM_INTEROP_THREADS', 0, { min: 0, max: 64 }),

  modelInputSize: 224,
});

if (problems.length > 0) {
  const msg = ['Invalid configuration:', ...problems.map((p) => `  - ${p}`)].join('\n');
  throw new Error(msg);
}

module.exports = config;
