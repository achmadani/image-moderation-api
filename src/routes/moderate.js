'use strict';

const { evaluate } = require('../services/verdict');
const { fail, toAppError, isAppError } = require('../utils/errors');

/** Bounds how many images are in flight at once, independent of HTTP keep-alive. */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
module.exports = async function moderateRoutes(fastify, opts) {
  const { config, pool, loader, metrics, cache } = opts;
  const limiter = new Semaphore(config.maxConcurrentRequests);

  const thresholds = Object.freeze({ block: config.thresholdBlock, review: config.thresholdReview });

  // base64 inflates bytes by ~4/3. The global bodyLimit stays small; each route
  // gets exactly the headroom its own input can legitimately need.
  const base64Overhead = (n) => Math.ceil(n * 1.4) + 8192;

  const meta = (request, startedAt) => ({
    requestId: request.id,
    processingMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    modelVersion: config.modelVersion,
    thresholds,
  });

  /**
   * Full pipeline for one image: validate, preprocess, infer, score.
   * @param {Buffer} buf
   */
  async function moderateBuffer(buf) {
    const prepared = await loader.prepare(buf);

    const image = {
      hash: config.storeImageHash ? prepared.hash : null,
      width: prepared.width,
      height: prepared.height,
      format: prepared.format,
      bytes: prepared.bytes,
    };

    const cacheKey = cache.key(prepared.hash, config);
    const cached = await cache.get(cacheKey);
    if (cached) {
      metrics.recordImage(cached.verdict);
      return { ...cached, image, cached: true };
    }

    const result = await pool.run(prepared.raw);
    metrics.recordInference(result);

    const scored = evaluate(result.predictions, {
      sexyWeight: config.sexyWeight,
      thresholdBlock: config.thresholdBlock,
      thresholdReview: config.thresholdReview,
    });

    await cache.set(cacheKey, scored);
    metrics.recordImage(scored.verdict);

    return { ...scored, image, cached: false };
  }

  /**
   * Pulls image bytes out of whichever input form the caller used.
   * @returns {Promise<Buffer[]>}
   */
  async function collectInputs(request, { batch }) {
    const limit = batch ? config.maxBatchSize : 1;
    const contentType = request.headers['content-type'] || '';

    if (contentType.startsWith('multipart/form-data')) {
      const buffers = [];
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file') continue;
          if (part.fieldname !== 'image') {
            part.file.resume();
            continue;
          }
          if (buffers.length >= limit) {
            part.file.resume();
            throw fail('BATCH_TOO_LARGE', `Batch exceeds MAX_BATCH_SIZE (${config.maxBatchSize})`, { limit: config.maxBatchSize });
          }
          const buf = await part.toBuffer();
          buffers.push(buf);
        }
      } catch (err) {
        throw normalizeMultipartError(err, config);
      }
      if (buffers.length === 0) {
        throw fail('NO_IMAGE_PROVIDED', 'No file was sent in the "image" field');
      }
      return buffers;
    }

    if (contentType.includes('application/json')) {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        throw fail('INVALID_INPUT', 'JSON body must be an object');
      }

      if (batch) {
        const items = body.images;
        if (!Array.isArray(items)) {
          throw fail('INVALID_INPUT', 'Batch body must contain an "images" array');
        }
        if (items.length === 0) {
          throw fail('NO_IMAGE_PROVIDED', '"images" array is empty');
        }
        if (items.length > config.maxBatchSize) {
          throw fail('BATCH_TOO_LARGE', `Batch of ${items.length} exceeds MAX_BATCH_SIZE (${config.maxBatchSize})`, {
            received: items.length,
            limit: config.maxBatchSize,
          });
        }
        // Resolved lazily per item so one bad URL cannot fail the whole batch.
        return items;
      }

      return [await resolveJsonItem(body)];
    }

    throw fail('INVALID_INPUT', 'Send multipart/form-data with an "image" file, or application/json with {url} or {base64}');
  }

  /** @returns {Promise<Buffer>} */
  async function resolveJsonItem(item) {
    if (!item || typeof item !== 'object') {
      throw fail('INVALID_INPUT', 'Each batch item must be an object with "url" or "base64"');
    }
    const hasUrl = typeof item.url === 'string' && item.url.trim() !== '';
    const hasBase64 = typeof item.base64 === 'string' && item.base64.trim() !== '';

    if (hasUrl && hasBase64) {
      throw fail('INVALID_INPUT', 'Provide either "url" or "base64", not both');
    }
    if (hasUrl) return loader.fromUrl(item.url);
    if (hasBase64) return loader.fromBase64(item.base64);
    throw fail('NO_IMAGE_PROVIDED', 'No image provided: expected "url" or "base64"');
  }

  // -------------------------------------------------------------------------
  // POST /v1/moderate
  // -------------------------------------------------------------------------
  fastify.post('/v1/moderate', { bodyLimit: base64Overhead(config.maxUploadBytes) }, async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    requireReady(pool);

    const [input] = await collectInputs(request, { batch: false });
    const buf = Buffer.isBuffer(input) ? input : await resolveJsonItem(input);
    const data = await limiter.run(() => moderateBuffer(buf));

    const { cached, ...payload } = data;
    reply.header('x-cache', cached ? 'hit' : 'miss');
    return { success: true, data: payload, meta: meta(request, startedAt) };
  });

  // -------------------------------------------------------------------------
  // POST /v1/moderate/batch — always 200 when the request itself is valid;
  // per-image failures are reported inside the results array.
  // -------------------------------------------------------------------------
  fastify.post('/v1/moderate/batch', { bodyLimit: base64Overhead(config.maxUploadBytes * config.maxBatchSize) }, async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    requireReady(pool);

    const inputs = await collectInputs(request, { batch: true });

    const results = await Promise.all(
      inputs.map(async (input, index) => {
        const id = !Buffer.isBuffer(input) && input && typeof input.id === 'string' ? input.id : null;
        try {
          const buf = Buffer.isBuffer(input) ? input : await resolveJsonItem(input);
          const { cached, ...payload } = await limiter.run(() => moderateBuffer(buf));
          return { index, id, success: true, data: payload, cached };
        } catch (err) {
          const appErr = toAppError(err);
          if (!isAppError(err)) {
            request.log.error({ err, index }, 'unexpected error while moderating batch item');
          }
          metrics.recordImage(appErr.code);
          return { index, id, success: false, error: appErr.toPayload() };
        }
      })
    );

    const succeeded = results.filter((r) => r.success).length;
    reply.code(200);
    return {
      success: true,
      data: {
        results,
        summary: { total: results.length, succeeded, failed: results.length - succeeded },
      },
      meta: meta(request, startedAt),
    };
  });
};

function requireReady(pool) {
  if (!pool.isReady()) {
    throw fail('MODEL_NOT_READY', 'Model is not loaded yet, retry shortly');
  }
}

/** Maps @fastify/multipart's own errors onto our error codes. */
function normalizeMultipartError(err, config) {
  if (isAppError(err)) return err;
  const code = err.code || '';
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
    return fail('FILE_TOO_LARGE', `Upload exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes} bytes)`, {
      limit: config.maxUploadBytes,
    });
  }
  if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
    return fail('BATCH_TOO_LARGE', `Too many parts in the multipart request (max ${config.maxBatchSize} files)`);
  }
  if (code.startsWith('FST_')) {
    return fail('INVALID_INPUT', `Malformed multipart request: ${err.message}`);
  }
  return err;
}

module.exports.Semaphore = Semaphore;
