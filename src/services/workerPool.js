'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { fail } = require('../utils/errors');

const WORKER_FILE = path.join(__dirname, '..', 'workers', 'inference.worker.js');
const RESTART_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

let nextTaskId = 1;

/**
 * Fixed-size pool of inference workers.
 *
 * One in-flight task per worker: TF.js inference saturates a core, so queueing
 * inside a worker only hides latency instead of bounding it. A worker that
 * times out or dies is terminated and replaced; its in-flight task is rejected.
 */
class WorkerPool extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.size
   * @param {string} opts.modelPath
   * @param {number} opts.modelInputSize
   * @param {number} opts.inferenceTimeoutMs
   * @param {number} [opts.tfIntraOpThreads]
   * @param {number} [opts.tfInterOpThreads]
   * @param {import('pino').Logger} opts.logger
   */
  constructor(opts) {
    super();
    this.size = opts.size;
    this.modelPath = opts.modelPath;
    this.modelInputSize = opts.modelInputSize;
    this.inferenceTimeoutMs = opts.inferenceTimeoutMs;
    this.tfIntraOpThreads = opts.tfIntraOpThreads || 0;
    this.tfInterOpThreads = opts.tfInterOpThreads || 0;
    this.logger = opts.logger;

    /** @type {Array<{worker: Worker, ready: boolean, task: object|null, restarts: number, id: number}>} */
    this.slots = [];
    this.queue = [];
    this.shuttingDown = false;
    this.startedAt = null;
    this.stats = { completed: 0, failed: 0, timeouts: 0, restarts: 0 };
  }

  /** Resolves once every worker has loaded the model and warmed up. */
  async start() {
    this.startedAt = Date.now();
    const boots = [];
    for (let i = 0; i < this.size; i += 1) {
      const slot = { worker: null, ready: false, task: null, restarts: 0, id: i };
      this.slots.push(slot);
      boots.push(this._spawn(slot));
    }
    await Promise.all(boots);
    this.logger.info({ workers: this.size }, 'worker pool ready');
  }

  /** True once at least one worker can serve traffic. Drives GET /ready. */
  isReady() {
    return !this.shuttingDown && this.slots.some((s) => s.ready);
  }

  status() {
    return {
      size: this.size,
      ready: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.task).length,
      queued: this.queue.length,
      ...this.stats,
    };
  }

  _spawn(slot) {
    return new Promise((resolve) => {
      const worker = new Worker(WORKER_FILE, {
        workerData: {
          modelPath: this.modelPath,
          modelInputSize: this.modelInputSize,
          tfIntraOpThreads: this.tfIntraOpThreads,
          tfInterOpThreads: this.tfInterOpThreads,
        },
      });

      slot.worker = worker;
      slot.ready = false;

      // Every handler ignores events from a worker this slot has already moved
      // on from: our own terminate() in _recycle still emits 'exit', and acting
      // on it would recycle the slot twice and orphan the replacement worker.
      const isCurrent = () => slot.worker === worker;

      worker.on('message', (msg) => {
        if (!isCurrent()) return;
        if (msg.type === 'ready') {
          slot.ready = true;
          this.logger.info({ worker: slot.id, backend: msg.backend, tfVersion: msg.tfVersion, namespace: msg.namespace }, 'worker ready');
          resolve();
          this._drain();
          return;
        }
        if (msg.type === 'fatal') {
          this.logger.error({ worker: slot.id, reason: msg.message }, 'worker reported fatal error');
          resolve(); // never block startup on one bad worker; isReady() still reports the truth
          return;
        }
        this._settle(slot, msg);
      });

      worker.on('error', (err) => {
        if (!isCurrent()) return;
        this.logger.error({ worker: slot.id, err: err.message }, 'worker error');
        resolve();
        this._recycle(slot, `worker error: ${err.message}`);
      });

      worker.on('exit', (code) => {
        if (!isCurrent() || this.shuttingDown) return;
        this.logger.warn({ worker: slot.id, code }, 'worker exited unexpectedly');
        resolve();
        this._recycle(slot, `worker exited with code ${code}`);
      });
    });
  }

  /** Rejects the in-flight task, then replaces the worker with a backoff. */
  _recycle(slot, reason, error) {
    slot.ready = false;

    const task = slot.task;
    slot.task = null;
    if (task) {
      clearTimeout(task.timer);
      this.stats.failed += 1;
      task.reject(error || fail('INTERNAL_ERROR', 'Inference worker restarted before the request completed'));
    }

    if (this.shuttingDown) return;

    const worker = slot.worker;
    slot.worker = null; // makes isCurrent() false, so terminate()'s 'exit' is ignored
    if (worker) worker.terminate().catch(() => {});

    const delay = RESTART_BACKOFF_MS[Math.min(slot.restarts, RESTART_BACKOFF_MS.length - 1)];
    slot.restarts += 1;
    this.stats.restarts += 1;
    this.emit('restart', { worker: slot.id, reason, restarts: slot.restarts });

    setTimeout(() => {
      if (this.shuttingDown) return;
      this.logger.warn({ worker: slot.id, reason, delayMs: delay }, 'restarting inference worker');
      this._spawn(slot).catch(() => {});
    }, delay).unref();
  }

  _settle(slot, msg) {
    const task = slot.task;
    if (!task || task.id !== msg.id) return; // late reply from a timed-out task
    clearTimeout(task.timer);
    slot.task = null;

    if (msg.type === 'result') {
      this.stats.completed += 1;
      task.resolve({
        predictions: msg.predictions,
        inferenceMs: msg.inferenceMs,
        numTensors: msg.numTensors,
        numBytes: msg.numBytes,
        rssBytes: msg.rssBytes,
        waitMs: task.startedAt - task.enqueuedAt,
      });
    } else {
      this.stats.failed += 1;
      task.reject(fail('INTERNAL_ERROR', 'Inference failed', { reason: msg.message }));
    }

    this._drain();
  }

  /**
   * @param {Buffer} rawRgb raw RGB pixels, modelInputSize² × 3 bytes
   * @returns {Promise<{predictions: Array, inferenceMs: number}>}
   */
  run(rawRgb) {
    if (this.shuttingDown) {
      return Promise.reject(fail('MODEL_NOT_READY', 'Service is shutting down'));
    }
    if (!this.isReady()) {
      return Promise.reject(fail('MODEL_NOT_READY', 'Model is not loaded yet'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: nextTaskId++,
        // Copy into a standalone ArrayBuffer: Buffer instances share one pooled
        // allocation, and transferring that would detach unrelated buffers.
        buffer: rawRgb.buffer.slice(rawRgb.byteOffset, rawRgb.byteOffset + rawRgb.byteLength),
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: 0,
        timer: null,
      });
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => s.ready && !s.task && s.worker);
      if (!slot) return;

      const task = this.queue.shift();
      task.startedAt = Date.now();
      slot.task = task;

      task.timer = setTimeout(() => {
        this.stats.timeouts += 1;
        this.logger.warn({ worker: slot.id, taskId: task.id, timeoutMs: this.inferenceTimeoutMs }, 'inference timed out, recycling worker');
        this._recycle(
          slot,
          'inference timeout',
          fail('INFERENCE_TIMEOUT', `Inference exceeded ${this.inferenceTimeoutMs}ms`)
        );
      }, this.inferenceTimeoutMs);
      task.timer.unref();

      slot.worker.postMessage({ type: 'infer', id: task.id, buffer: task.buffer }, [task.buffer]);
    }
  }

  /** Rejects everything still queued, then terminates every worker. */
  async destroy() {
    this.shuttingDown = true;

    for (const task of this.queue.splice(0)) {
      clearTimeout(task.timer);
      task.reject(fail('MODEL_NOT_READY', 'Service is shutting down'));
    }

    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.task) {
          clearTimeout(slot.task.timer);
          slot.task.reject(fail('MODEL_NOT_READY', 'Service is shutting down'));
          slot.task = null;
        }
        slot.ready = false;
        if (slot.worker) {
          await slot.worker.terminate().catch(() => {});
          slot.worker = null;
        }
      })
    );
    this.logger.info('worker pool terminated');
  }
}

module.exports = { WorkerPool };
