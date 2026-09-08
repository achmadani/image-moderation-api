'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * Single logger definition shared by the Fastify server and the workers, so
 * worker output lands in the same json stream as request logs.
 */
function createLogger(bindings = {}) {
  return pino({
    level: config.logLevel,
    base: { service: 'image-moderation', ...bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers["x-api-key"]', 'headers["x-api-key"]', 'apiKey'],
      censor: '[redacted]',
    },
  });
}

module.exports = { createLogger, logger: createLogger() };
