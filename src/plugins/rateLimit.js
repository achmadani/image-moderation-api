'use strict';

const fp = require('fastify-plugin');
const rateLimit = require('@fastify/rate-limit');
const { AppError } = require('../utils/errors');

/**
 * Per-API-key rate limiting. Falls back to the client IP when auth is off.
 * In-process only: this service runs as a single container behind nginx, so a
 * shared store would add a Redis dependency for no benefit.
 */
async function rateLimitPlugin(fastify, opts) {
  const { config } = opts;
  if (!config.rateLimitEnabled) return;

  await fastify.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator: (request) => request.apiKeyId || request.ip,
    // Health and metrics must stay reachable even while a caller is throttled.
    allowList: (request) => ['/health', '/ready', '/metrics'].includes(request.routeOptions?.url || request.url.split('?')[0]),
    errorResponseBuilder: (request, context) =>
      new AppError('RATE_LIMITED', `Rate limit exceeded: ${context.max} requests per ${context.after}`, {
        limit: context.max,
        retryAfterMs: context.ttl,
      }),
  });
}

module.exports = fp(rateLimitPlugin, { name: 'rateLimit' });
