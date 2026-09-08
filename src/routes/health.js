'use strict';

/**
 * Liveness, readiness and metrics. All three are exempt from auth and rate
 * limiting so the container healthcheck and a local Prometheus scrape work
 * without credentials.
 */
module.exports = async function healthRoutes(fastify, opts) {
  const { config, pool, metrics, state } = opts;
  const startedAt = Date.now();

  // GET /health — liveness. 200 as soon as the process is up, regardless of
  // whether the model has finished loading. Restarting on a slow model load
  // would turn a cold start into a crash loop.
  fastify.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    version: config.modelVersion,
  }));

  // GET /ready — readiness. 200 only once the model is loaded and a worker can
  // serve traffic, and 503 again the moment shutdown starts.
  fastify.get('/ready', async (request, reply) => {
    const poolStatus = pool.status();
    const ready = pool.isReady() && !state.shuttingDown;

    reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not-ready',
      shuttingDown: state.shuttingDown,
      workers: poolStatus,
    };
  });

  fastify.get('/metrics', async (request, reply) => {
    if (!config.metricsEnabled) {
      reply.code(404);
      return { success: false, error: { code: 'INVALID_INPUT', message: 'Metrics are disabled', details: {} }, meta: { requestId: request.id } };
    }
    metrics.syncPool(pool.status());
    reply.header('content-type', metrics.contentType);
    return metrics.render();
  });
};
