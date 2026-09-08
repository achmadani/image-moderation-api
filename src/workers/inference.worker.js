'use strict';

/**
 * Inference worker. TF.js inference is CPU-bound and blocking, so it never runs
 * on the main thread. The model is loaded exactly once here, at worker startup,
 * from the baked MODEL_PATH — never per request and never over the network.
 */

const { parentPort, workerData } = require('worker_threads');

if (!parentPort) throw new Error('inference.worker.js must be started as a worker_thread');

const { modelPath, modelInputSize, tfIntraOpThreads, tfInterOpThreads } = workerData;

// Must be set before tfjs-node is required: libtensorflow reads them when the
// backend is created. Without this every worker spawns a pool sized to all
// cores, which starves the other services on the box.
if (tfIntraOpThreads > 0) process.env.TF_NUM_INTRAOP_THREADS = String(tfIntraOpThreads);
if (tfInterOpThreads > 0) process.env.TF_NUM_INTEROP_THREADS = String(tfInterOpThreads);
process.env.TF_CPP_MIN_LOG_LEVEL = process.env.TF_CPP_MIN_LOG_LEVEL || '2';

// Resolves the usable namespace rather than trusting tfjs-node's re-export,
// which comes up empty on some platform/Node combinations. See src/utils/tf.js.
const { tf, namespace, tfVersion, ensureReady } = require('../utils/tf');
const nsfw = require('nsfwjs');

let model = null;

async function init() {
  // Fails loudly here if the native backend or the file:// router is missing,
  // rather than surfacing as an unreadable model-load error a moment later.
  await ensureReady();

  model = await nsfw.load(`file://${modelPath}/model.json`, { size: modelInputSize });

  // Warm up so the first real request does not pay lazy kernel allocation.
  const warm = tf.zeros([modelInputSize, modelInputSize, 3], 'int32');
  try {
    await model.classify(warm);
  } finally {
    warm.dispose();
  }

  parentPort.postMessage({ type: 'ready', backend: tf.getBackend(), tfVersion, namespace });
}

/**
 * @param {ArrayBuffer} buffer raw RGB, already resized to modelInputSize by sharp
 */
async function infer(buffer) {
  const expected = modelInputSize * modelInputSize * 3;
  const pixels = new Uint8Array(buffer);
  if (pixels.length !== expected) {
    throw new Error(`expected ${expected} bytes of raw RGB, got ${pixels.length}`);
  }

  // The only tensor we own; nsfwjs wraps its own intermediates in tf.tidy and
  // disposes the logits, so disposing this one keeps the tensor count flat.
  const input = tf.tensor3d(pixels, [modelInputSize, modelInputSize, 3], 'int32');
  try {
    return await model.classify(input);
  } finally {
    input.dispose();
  }
}

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'infer') return;

  if (!model) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: 'model not loaded' });
    return;
  }

  const startedAt = process.hrtime.bigint();
  try {
    const predictions = await infer(msg.buffer);
    parentPort.postMessage({
      type: 'result',
      id: msg.id,
      predictions,
      inferenceMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      numTensors: tf.memory().numTensors,
      numBytes: tf.memory().numBytes,
      rssBytes: process.memoryUsage().rss,
    });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: err.message });
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'fatal', message: `model load failed: ${err.message}` });
  process.exit(1);
});
