'use strict';

const client = require('prom-client');

/**
 * Prometheus metrics. Instantiated once and shared; when METRICS_ENABLED is
 * false nothing is registered and every record* call is a no-op, so callers do
 * not need to branch.
 */
class Metrics {
  constructor(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) return;

    this.registry = new client.Registry();
    this.registry.setDefaultLabels({ service: 'image-moderation' });
    client.collectDefaultMetrics({ register: this.registry, prefix: 'moderation_' });

    this.requests = new client.Counter({
      name: 'moderation_requests_total',
      help: 'Moderation requests by route and outcome',
      labelNames: ['route', 'status'],
      registers: [this.registry],
    });

    this.images = new client.Counter({
      name: 'moderation_images_total',
      help: 'Individual images processed, by verdict or error code',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.duration = new client.Histogram({
      name: 'moderation_request_duration_seconds',
      help: 'End-to-end moderation latency',
      labelNames: ['route'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.inference = new client.Histogram({
      name: 'moderation_inference_duration_seconds',
      help: 'Time spent inside the worker running the model',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.queueWait = new client.Histogram({
      name: 'moderation_queue_wait_seconds',
      help: 'Time a task waited for a free worker',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.poolGauges = new client.Gauge({
      name: 'moderation_worker_pool',
      help: 'Worker pool state',
      labelNames: ['state'],
      registers: [this.registry],
    });

    this.workerRestarts = new client.Counter({
      name: 'moderation_worker_restarts_total',
      help: 'Inference workers replaced after a crash or timeout',
      registers: [this.registry],
    });
  }

  recordRequest(route, status, seconds) {
    if (!this.enabled) return;
    this.requests.inc({ route, status });
    this.duration.observe({ route }, seconds);
  }

  recordImage(outcome) {
    if (!this.enabled) return;
    this.images.inc({ outcome });
  }

  recordInference({ inferenceMs, waitMs }) {
    if (!this.enabled) return;
    if (Number.isFinite(inferenceMs)) this.inference.observe(inferenceMs / 1000);
    if (Number.isFinite(waitMs)) this.queueWait.observe(waitMs / 1000);
  }

  recordWorkerRestart() {
    if (!this.enabled) return;
    this.workerRestarts.inc();
  }

  /** Pulled at scrape time so the gauges never go stale. */
  syncPool(status) {
    if (!this.enabled) return;
    this.poolGauges.set({ state: 'size' }, status.size);
    this.poolGauges.set({ state: 'ready' }, status.ready);
    this.poolGauges.set({ state: 'busy' }, status.busy);
    this.poolGauges.set({ state: 'queued' }, status.queued);
  }

  async render() {
    if (!this.enabled) return '';
    return this.registry.metrics();
  }

  get contentType() {
    return this.enabled ? this.registry.contentType : 'text/plain';
  }
}

module.exports = { Metrics };
