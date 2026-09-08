'use strict';

/**
 * Exercises rule #6: a worker that times out or dies is replaced automatically
 * and the pool keeps serving. Not a unit test — it drives the real pool.
 */
const assert = require('assert');
const sharp = require('sharp');
const config = require('../src/config');
const { WorkerPool } = require('../src/services/workerPool');
const { createLogger } = require('../src/utils/logger');

const SIZE = config.modelInputSize;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 20000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const logger = createLogger({ component: 'pool-test' }).child({}, { level: 'error' });
  const raw = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 90, g: 140, b: 60 } } })
    .removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer();

  const pool = new WorkerPool({
    size: 2,
    modelPath: config.modelPath,
    modelInputSize: SIZE,
    inferenceTimeoutMs: 15000,
    tfIntraOpThreads: config.tfIntraOpThreads,
    tfInterOpThreads: config.tfInterOpThreads,
    logger,
  });

  // --- rejects before start -------------------------------------------------
  await assert.rejects(pool.run(Buffer.from(raw)), (e) => e.code === 'MODEL_NOT_READY');
  console.log('ok  run() before start -> MODEL_NOT_READY');

  await pool.start();
  assert.strictEqual(pool.isReady(), true);
  console.log('ok  pool ready after start');

  // --- happy path -----------------------------------------------------------
  const first = await pool.run(Buffer.from(raw));
  assert.strictEqual(first.predictions.length, 5);
  console.log('ok  single inference ->', first.predictions[0].className, first.predictions[0].probability.toFixed(3));

  // --- queueing under concurrency ------------------------------------------
  const N = 20;
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, () => pool.run(Buffer.from(raw))));
  assert.strictEqual(results.length, N);
  assert.ok(results.every((r) => r.predictions.length === 5));
  assert.ok(results.some((r) => r.waitMs > 0), 'expected at least one task to queue behind a busy worker');
  console.log(`ok  ${N} concurrent inferences in ${Date.now() - t0}ms across 2 workers`);

  // --- inference timeout recycles the worker -------------------------------
  const restartsBefore = pool.stats.restarts;
  pool.inferenceTimeoutMs = 1;
  await assert.rejects(pool.run(Buffer.from(raw)), (e) => e.code === 'INFERENCE_TIMEOUT');
  console.log('ok  timeout -> INFERENCE_TIMEOUT');
  assert.ok(pool.stats.restarts > restartsBefore, 'timeout should trigger a restart');

  pool.inferenceTimeoutMs = 15000;
  await waitFor(() => pool.status().ready === 2, 30000, 'both workers back after timeout');
  console.log('ok  worker replaced after timeout, pool back to 2/2');

  const afterTimeout = await pool.run(Buffer.from(raw));
  assert.strictEqual(afterTimeout.predictions.length, 5);
  console.log('ok  inference works again after recycle');

  // --- hard crash recycles the worker --------------------------------------
  const crashRestarts = pool.stats.restarts;
  const victim = pool.slots.find((s) => s.worker);
  await victim.worker.terminate();
  await waitFor(() => pool.stats.restarts > crashRestarts, 20000, 'restart after crash');
  await waitFor(() => pool.status().ready === 2, 30000, 'both workers back after crash');
  console.log('ok  worker killed externally -> replaced, pool back to 2/2');

  const afterCrash = await pool.run(Buffer.from(raw));
  assert.strictEqual(afterCrash.predictions.length, 5);
  console.log('ok  inference works again after crash');

  // --- shutdown -------------------------------------------------------------
  await pool.destroy();
  assert.strictEqual(pool.isReady(), false);
  await assert.rejects(pool.run(Buffer.from(raw)), (e) => e.code === 'MODEL_NOT_READY');
  console.log('ok  destroy() -> not ready, further work rejected');

  console.log('\nstats:', JSON.stringify(pool.status()));
  console.log('RESULT: OK');
}

main().catch((e) => { console.error('RESULT: FAIL'); console.error(e); process.exit(1); });
