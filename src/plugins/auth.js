'use strict';

const crypto = require('crypto');
const fp = require('fastify-plugin');
const { fail } = require('../utils/errors');

/** Constant-time compare that does not leak the key length either. */
function keyMatches(candidate, keys) {
  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  let matched = false;
  for (const key of keys) {
    const keyHash = crypto.createHash('sha256').update(key).digest();
    if (crypto.timingSafeEqual(candidateHash, keyHash)) matched = true;
  }
  return matched;
}

/**
 * X-API-Key authentication. Liveness, readiness and metrics stay open so the
 * container healthcheck and the local Prometheus scrape do not need a key.
 */
async function authPlugin(fastify, opts) {
  const { config } = opts;
  const openPaths = new Set(['/health', '/ready', '/metrics']);

  fastify.decorateRequest('apiKeyId', null);

  fastify.addHook('onRequest', async (request) => {
    if (!config.authEnabled) return;
    if (openPaths.has(request.routeOptions?.url || request.url.split('?')[0])) return;

    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw fail('UNAUTHORIZED', 'Missing X-API-Key header');
    }
    if (!keyMatches(provided, config.apiKeys)) {
      request.log.warn({ ip: request.ip }, 'rejected request with invalid API key');
      throw fail('UNAUTHORIZED', 'Invalid API key');
    }

    // Short, non-reversible identifier so logs and rate-limit buckets can refer
    // to a key without ever containing it.
    request.apiKeyId = crypto.createHash('sha256').update(provided).digest('hex').slice(0, 12);
  });
}

module.exports = fp(authPlugin, { name: 'auth' });
