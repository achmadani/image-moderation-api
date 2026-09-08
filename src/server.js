'use strict';

const Fastify = require('fastify');
const multipart = require('@fastify/multipart');

const config = require('./config');
const { createLogger } = require('./utils/logger');
const { WorkerPool } = require('./services/workerPool');
const { ImageLoader } = require('./services/imageLoader');
const { ResultCache } = require('./services/cache');
const { Metrics } = require('./services/metrics');
const authPlugin = require('./plugins/auth');
const rateLimitPlugin = require('./plugins/rateLimit');
const moderateRoutes = require('./routes/moderate');
const healthRoutes = require('./routes/health');
const { errorResponse, toAppError, isAppError, fail } = require('./utils/errors');

/**
 * Builds the server and every dependency it owns. Exported so integration
 * tests can drive it with fastify.inject() instead of a real socket.
 */
async function build({ startPool = true } = {}) {
  const logger = createLogger();
  const state = { shuttingDown: false };

  const metrics = new Metrics(config.metricsEnabled);
  const cache = new ResultCache(config, logger);
  const loader = new ImageLoader(config, logger);
  const pool = new WorkerPool({
    size: config.workerPoolSize,
    modelPath: config.modelPath,
    modelInputSize: config.modelInputSize,
    inferenceTimeoutMs: config.inferenceTimeoutMs,
    tfIntraOpThreads: config.tfIntraOpThreads,
    tfInterOpThreads: config.tfInterOpThreads,
    logger,
  });
  pool.on('restart', () => metrics.recordWorkerRestart());

  const fastify = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    requestTimeout: config.requestTimeoutMs,
    bodyLimit: 1024 * 1024, // routes that accept images raise this themselves
    trustProxy: true, // nginx is the only thing in front of this service
    genReqId: (req) => req.headers['x-request-id'] || require('crypto').randomUUID(),
  });

  // Must be installed before any register(): `await register` creates the child
  // context there and then, and a child only inherits the handlers that exist
  // at that moment. Set afterwards, routes keep Fastify's default JSON errors.
  fastify.setErrorHandler((err, request, reply) => {
    let appErr;
    if (isAppError(err)) {
      appErr = err;
    } else if (err.statusCode === 400 && /JSON|body/i.test(err.message || '')) {
      appErr = fail('INVALID_INPUT', 'Request body is not valid JSON');
    } else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_ERR_CTP_EMPTY_TYPE') {
      appErr = fail('INVALID_INPUT', 'Unsupported request Content-Type: use multipart/form-data or application/json');
    } else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      appErr = fail('FILE_TOO_LARGE', `Request body exceeds the limit for this route (MAX_UPLOAD_BYTES=${config.maxUploadBytes})`);
    } else if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      appErr = fail('FILE_TOO_LARGE', `Upload exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes} bytes)`);
    } else {
      appErr = toAppError(err);
      request.log.error({ err }, 'unhandled error');
    }

    // No metric here: onResponse fires for this reply too, and counting in
    // both places produced two series for every failed request.
    reply.code(appErr.statusCode).send(errorResponse(appErr, request.id));
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorResponse(fail('INVALID_INPUT', `Route ${request.method} ${request.url} does not exist`), request.id));
  });

  fastify.addHook('onResponse', async (request, reply) => {
    metrics.recordRequest(request.routeOptions?.url || 'unknown', String(reply.statusCode), reply.elapsedTime / 1000);
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: config.maxBatchSize,
      fields: 10,
    },
  });

  await fastify.register(authPlugin, { config });
  await fastify.register(rateLimitPlugin, { config });

  await fastify.register(healthRoutes, { config, pool, metrics, state });
  await fastify.register(moderateRoutes, { config, pool, loader, metrics, cache });

  fastify.decorate('appState', state);
  fastify.decorate('pool', pool);
  fastify.decorate('cache', cache);
  fastify.decorate('metrics', metrics);
  fastify.decorate('appConfig', config);

  await cache.connect();
  if (startPool) await pool.start();

  return fastify;
}

/**
 * Rule #7: stop accepting new work, let in-flight requests finish, then tear
 * down the workers. /ready flips to 503 first so nginx drains us.
 */
function installShutdownHandlers(fastify) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.appState.shuttingDown = true;
    fastify.log.info({ signal }, 'shutdown requested, draining');

    const force = setTimeout(() => {
      fastify.log.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, Math.max(config.requestTimeoutMs, 10000) + config.shutdownDrainMs + 5000);
    force.unref();

    try {
      // Report unhealthy before closing the listener. Without this pause the
      // socket is gone the instant SIGTERM lands and nginx gets a connection
      // refusal rather than the 503 that tells it to stop sending traffic.
      if (config.shutdownDrainMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.shutdownDrainMs));
      }
      await fastify.close();          // stops the listener, finishes in-flight requests
      await fastify.pool.destroy();   // terminates the workers
      await fastify.cache.close();
      fastify.log.info('shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      fastify.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => fastify.log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    fastify.log.fatal({ err }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

async function main() {
  let fastify;
  try {
    fastify = await build();
  } catch (err) {
    // Config and model problems must be loud and fatal, not a half-up service.
    console.error(err.message);
    process.exit(1);
  }

  installShutdownHandlers(fastify);

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    fastify.log.fatal({ err }, 'failed to bind');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { build, installShutdownHandlers };
