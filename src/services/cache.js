'use strict';

const Redis = require('ioredis');

/**
 * Optional result cache keyed by the image SHA-256. Only the verdict is stored
 * — never the image bytes. Every operation is best-effort: a Redis outage
 * degrades throughput, it must never fail a moderation request.
 */
class ResultCache {
  constructor(config, logger) {
    this.enabled = Boolean(config.cacheEnabled);
    this.ttl = config.cacheTtlSeconds;
    this.logger = logger;
    this.client = null;
    this.healthy = false;

    if (!this.enabled) return;

    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    this.client.on('error', (err) => {
      if (this.healthy) this.logger.warn({ err: err.message }, 'redis cache error, continuing without cache');
      this.healthy = false;
    });
    this.client.on('ready', () => {
      this.healthy = true;
      this.logger.info('redis cache connected');
    });
  }

  async connect() {
    if (!this.enabled) return;
    try {
      await this.client.connect();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'redis cache unavailable at startup, continuing without cache');
    }
  }

  key(hash, config) {
    // Thresholds are part of the key: changing them must not serve stale verdicts.
    return `nsfw:${config.modelVersion}:${config.thresholdBlock}:${config.thresholdReview}:${config.sexyWeight}:${hash}`;
  }

  async get(key) {
    if (!this.enabled || !this.healthy) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async set(key, value) {
    if (!this.enabled || !this.healthy) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', this.ttl);
    } catch {
      /* best effort */
    }
  }

  async close() {
    if (!this.enabled || !this.client) return;
    try { await this.client.quit(); } catch { this.client.disconnect(); }
  }
}

module.exports = { ResultCache };
