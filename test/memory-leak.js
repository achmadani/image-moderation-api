'use strict';

/**
 * Leak check for rule #1: run N inferences through the real worker pool and
 * print RSS every REPORT_EVERY iterations. RSS must stay flat — a rising trend
 * means a tensor is escaping tf.tidy()/dispose() somewhere.
 *
 *   node test/memory-leak.js [iterations]
 */

const sharp = require('sharp');
const config = require('../src/config');
const { WorkerPool } = require('../src/services/workerPool');
const { createLogger } = require('../src/utils/logger');

const ITERATIONS = Number(process.argv[2] || process.env.LEAK_ITERATIONS || 1000);
const REPORT_EVERY = Number(process.env.LEAK_REPORT_EVERY || 100);
const SIZE = config.modelInputSize;
const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

async function main() {
  const logger = createLogger({ component: 'leak-test' }).child({}, { level: 'warn' });
  const pool = new WorkerPool({
    size: config.workerPoolSize,
    modelPath: config.modelPath,
    modelInputSize: SIZE,
    inferenceTimeoutMs: config.inferenceTimeoutMs,
    tfIntraOpThreads: config.tfIntraOpThreads,
    tfInterOpThreads: config.tfInterOpThreads,
    logger,
  });

  await pool.start();

  // A handful of distinct images so the run cannot be served from any cache.
  const variants = await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      sharp({ create: { width: 512, height: 384, channels: 3, background: { r: 20 + i * 45, g: 200 - i * 30, b: 60 + i * 35 } } })
        .jpeg({ quality: 90 })
        .toBuffer()
    )
  );

  const rawVariants = await Promise.all(
    variants.map((buf) =>
      sharp(buf).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer()
    )
  );

  console.log(`iterations=${ITERATIONS} workers=${config.workerPoolSize} node=${process.version} ${process.platform}/${process.arch}`);
  // worker_threads share the process, so RSS covers main + every worker at once.
  console.log('iter   procRSS   mainHeap   extHeap    workerTensors   ms/inf');

  const samples = [];
  let lastReport = Date.now();
  let workerTensors = 0;
  let workerBytes = 0;

  for (let i = 1; i <= ITERATIONS; i += 1) {
    // Fresh Buffer per call: the pool copies it into a transferable, and reusing
    // one buffer would hide a copy bug.
    const raw = Buffer.from(rawVariants[i % rawVariants.length]);
    const res = await pool.run(raw);
    workerTensors = res.numTensors;
    workerBytes = res.numBytes;

    if (i % REPORT_EVERY === 0) {
      const mem = process.memoryUsage();
      const perInf = (Date.now() - lastReport) / REPORT_EVERY;
      lastReport = Date.now();
      samples.push({ i, rss: mem.rss, external: mem.external, tensors: workerTensors, bytes: workerBytes });
      console.log(
        String(i).padEnd(6),
        `${MB(mem.rss)}MB`.padEnd(9),
        `${MB(mem.heapUsed)}MB`.padEnd(10),
        `${MB(mem.external)}MB`.padEnd(10),
        String(workerTensors).padEnd(15),
        perInf.toFixed(1)
      );
    }
  }

  await pool.destroy();

  // How to read these numbers.
  //
  // The tensor-leak signal is exact, not statistical: tf.memory() reports the
  // live tensor count and their total bytes. A leaked tensor moves both, with
  // no noise to argue about. Those are the real gates.
  //
  // RSS is the second gate, because that is what the container's mem_limit
  // kills on.
  //
  // External heap is printed but NOT gated. Tensor data lives in external
  // memory, which sawtooths between GC cycles — over a clean run it swings
  // between ~3MB and ~30MB with no trend. Sampling every REPORT_EVERY
  // iterations aliases that oscillation, so any average or minimum taken from
  // it reports the sampling phase rather than the memory behaviour. An earlier
  // version of this script gated on it and passed or failed at random.
  const half = Math.floor(samples.length / 2);
  if (samples.length < 4) {
    console.error(`RESULT: FAIL — only ${samples.length} samples; run at least ${REPORT_EVERY * 4} iterations to judge a trend`);
    process.exit(1);
  }
  const firstHalf = samples.slice(0, half);
  const secondHalf = samples.slice(half);
  const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
  const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

  const rssGrowth = ((avg(secondHalf, 'rss') - avg(firstHalf, 'rss')) / avg(firstHalf, 'rss')) * 100;
  const tensorCounts = [...new Set(samples.map((s) => s.tensors))];
  const byteCounts = [...new Set(samples.map((s) => s.bytes))];

  console.log('');
  console.log(`tf tensors       : ${tensorCounts.join(', ')}   [gate: must be one constant]`);
  console.log(`tf bytes         : ${byteCounts.map((b) => MB(b) + 'MB').join(', ')}   [gate: must be one constant]`);
  console.log(`process RSS mean : ${MB(avg(firstHalf, 'rss'))}MB -> ${MB(avg(secondHalf, 'rss'))}MB (${fmt(rssGrowth)})   [gate]`);
  console.log(`external heap    : ${MB(Math.min(...samples.map((x) => x.external)))}MB..${MB(Math.max(...samples.map((x) => x.external)))}MB (GC sawtooth, not gated)`);

  const failures = [];
  if (tensorCounts.length > 1) failures.push(`live tensor count changed during the run: ${tensorCounts.join(' -> ')}`);
  if (byteCounts.length > 1) failures.push(`live tensor bytes changed during the run: ${byteCounts.join(' -> ')}`);
  // 5% covers GC jitter and allocator behaviour; a real leak grows far faster.
  if (rssGrowth > 5) failures.push(`process RSS grew ${fmt(rssGrowth)} between halves`);

  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: OK — RSS flat, tensor count constant');
}

main().catch((e) => { console.error('RESULT: FAIL'); console.error(e); process.exit(1); });
