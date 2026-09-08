'use strict';

/**
 * Build-time gate. Runs inside the Docker `verify` stage, on the image's own
 * node_modules, and fails the build if TensorFlow.js cannot actually be used.
 *
 * It exercises the same resolver the workers use, so a build that passes here
 * cannot produce a container whose workers die on their first tf call.
 */

const { tf, namespace, tfVersion, inspect, ensureReady } = require('../src/utils/tf');

const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

async function main() {
  console.log('tfjs runtime check');
  line('node', `${process.version} ${process.platform}/${process.arch}`);
  line('tfjs-core version', tfVersion);
  line('namespace in use', namespace);

  // Also asserts the file:// IO router, which the app needs to load MODEL_PATH.
  const { backend } = await ensureReady();
  line('backend', backend);
  line('file:// io router', 'registered');

  if (namespace !== '@tensorflow/tfjs-node') {
    // Not fatal, but worth seeing in the build log: it means tfjs-node's
    // re-export came up empty and we fell back to the union package.
    console.log(`  NOTE: @tensorflow/tfjs-node re-exported nothing usable; falling back to ${namespace}`);
    console.table(inspect());
  }

  // A real op through the real backend, not just a smoke check on typeof.
  const before = tf.memory().numTensors;
  const t = tf.tensor3d(new Uint8Array(2 * 2 * 3), [2, 2, 3], 'int32');
  const sum = t.sum().dataSync()[0];
  t.dispose();
  line('tensor3d + sum', `ok (sum=${sum})`);

  const leaked = tf.memory().numTensors - before;
  if (leaked > 1) {
    // `sum()` leaves its own result behind here; anything beyond that is wrong.
    throw new Error(`tensor accounting is broken: ${leaked} tensors left after a single op`);
  }

  console.log('  RESULT: ok');
}

main().catch((err) => {
  console.error('\ntfjs runtime check FAILED');
  console.error(`  ${err.message}\n`);
  console.error('  namespace candidates:');
  try {
    for (const row of inspect()) {
      console.error(`    ${row.name.padEnd(24)} resolvable=${row.resolvable} keys=${row.keys} missing=[${row.missing.join(', ')}]`);
    }
  } catch { /* inspect itself may be unavailable */ }
  console.error('\n  If a candidate shows only 2 keys, its dist/index.js stopped early:');
  console.error('  rebuild the dependency layer from scratch with `docker build --no-cache`.');
  process.exit(1);
});
