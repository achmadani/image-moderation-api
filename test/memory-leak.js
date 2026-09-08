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

  for (let i = 1; i <= ITERATIONS; i += 1) {
    // Fresh Buffer per call: the pool copies it into a transferable, and reusing
    // one buffer would hide a copy bug.
    const raw = Buffer.from(rawVariants[i % rawVariants.length]);
    const res = await pool.run(raw);
    workerTensors = res.numTensors;

    if (i % REPORT_EVERY === 0) {
      const mem = process.memoryUsage();
      const perInf = (Date.now() - lastReport) / REPORT_EVERY;
      lastReport = Date.now();
      samples.push({ i, rss: mem.rss, external: mem.external });
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

  // Compare the second half against the first: startup allocation makes the
  // very first samples misleading, but the tail must be stable.
  const half = Math.floor(samples.length / 2);
  const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
  const firstHalf = samples.slice(0, half);
  const secondHalf = samples.slice(half);

  const report = (label, key) => {
    const a = avg(firstHalf, key);
    const b = avg(secondHalf, key);
    const growthPct = ((b - a) / a) * 100;
    console.log(`${label}: first half ${MB(a)}MB -> second half ${MB(b)}MB (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%)`);
    return growthPct;
  };

  console.log('');
  const rssGrowth = report('process RSS  ', 'rss');
  const extGrowth = report('external heap', 'external');
  console.log(`worker tensor count at end: ${workerTensors} (must equal the constant model weight count)`);

  // 5% covers GC jitter; a real tensor leak grows far faster than that.
  const LIMIT = 5;
  if (rssGrowth > LIMIT || extGrowth > LIMIT) {
    console.error(`RESULT: FAIL — RSS grew more than ${LIMIT}% between halves`);
    process.exit(1);
  }
  console.log('RESULT: OK — RSS flat');
}

main().catch((e) => { console.error('RESULT: FAIL'); console.error(e); process.exit(1); });
