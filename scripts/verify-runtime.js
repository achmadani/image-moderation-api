'use strict';

/**
 * Build-time gate. Runs inside the Docker `verify` stage, on the image's own
 * node_modules, and fails the build if TensorFlow.js cannot actually be used.
 *
 * It exercises the same resolver the workers use, so a build that passes here
 * cannot produce a container whose workers die on their first tf call.
 */

const fs = require('fs');
const path = require('path');

const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

/**
 * Runs BEFORE tfjs is touched. An installed tree that does not match
 * package.json produces failures far downstream — a tfjs-node 1.x install, for
 * instance, surfaces only as "getBackend is not a function" — so name the
 * mismatch here instead.
 */
function assertInstalledVersions() {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  for (const name of ['@tensorflow/tfjs-node', 'nsfwjs', 'sharp']) {
    const wanted = pkg.dependencies[name];
    const wantedMajor = String(wanted).replace(/^[^0-9]*/, '').split('.')[0];

    const installedPath = path.join(root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(installedPath)) {
      throw new Error(`${name} is declared in package.json (${wanted}) but is not installed`);
    }
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8')).version;

    if (installed.split('.')[0] !== wantedMajor) {
      throw new Error(
        `${name} ${installed} is installed, but package.json asks for ${wanted}. ` +
        'node_modules does not match this project — the package-lock.json used by ' +
        '`npm ci` is not the one committed here. Compare its checksum with the repo copy.'
      );
    }
    console.log(`  ${name.padEnd(20)} ${installed}`);
  }

  // The npm v6 layout nests a second copy of a package under its dependent,
  // which gives each copy its own backend registry.
  const nested = path.join(root, 'node_modules', '@tensorflow', 'tfjs-node', 'node_modules', '@tensorflow', 'tfjs-core');
  if (fs.existsSync(nested)) {
    throw new Error(
      'a nested @tensorflow/tfjs-core exists under tfjs-node. That is an npm v6 ' +
      '(lockfileVersion 1) install layout; this project pins lockfileVersion 3 with no nested copies. ' +
      'node_modules was built from a different lockfile.'
    );
  }
}

async function main() {
  console.log('tfjs runtime check');
  console.log('  installed packages:');
  assertInstalledVersions();

  // Required only after the version gate, so a mismatched tree reports itself
  // instead of throwing somewhere inside tfjs.
  const { tf, namespace, tfVersion, ensureReady } = require('../src/utils/tf');
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
    for (const row of require('../src/utils/tf').inspect()) {
      console.error(`    ${row.name.padEnd(24)} resolvable=${row.resolvable} keys=${row.keys} missing=[${row.missing.join(', ')}]`);
    }
  } catch { /* inspect itself may be unavailable */ }

  dumpModuleForensics();
  process.exit(1);
});

/**
 * Everything needed to tell apart the ways tfjs-node can come up half-built:
 * a module body that never finished (cycle), a body that finished but whose
 * re-export copied nothing, a truncated file, or two separate copies of the
 * core package registering backends on different registries.
 */
function dumpModuleForensics() {
  const fs = require('fs');
  const out = (k, v) => console.error(`    ${String(k).padEnd(26)} ${v}`);

  console.error('\n  module forensics:');

  const paths = {};
  for (const name of ['@tensorflow/tfjs-node', '@tensorflow/tfjs', '@tensorflow/tfjs-core', 'nsfwjs']) {
    try {
      paths[name] = require.resolve(name);
      out(name, paths[name]);
    } catch (err) {
      out(name, `UNRESOLVED (${err.message})`);
    }
  }

  // Duplicate installs are the classic reason registerBackend and getBackend
  // disagree: each copy keeps its own backend registry.
  const cores = Object.keys(require.cache).filter((p) => /tfjs-core[\\/]/.test(p));
  out('tfjs-core copies loaded', cores.length);
  for (const c of cores.slice(0, 5)) out('  ', c);

  const nodePath = paths['@tensorflow/tfjs-node'];
  if (!nodePath) return;

  // module.loaded is false only while a module body is still executing, i.e.
  // when we are holding a partially-initialised export object from a cycle.
  const entry = require.cache[nodePath];
  out('tfjs-node module.loaded', entry ? String(entry.loaded) : '(not in require.cache)');
  const nodeKeys = entry ? Object.keys(entry.exports) : [];
  out('tfjs-node exports keys', entry ? `${nodeKeys.length}: ${nodeKeys.slice(0, 10).join(', ')}${nodeKeys.length > 10 ? ' ...' : ''}` : 'n/a');
  out('tfjs-node own props', entry ? Object.getOwnPropertyNames(entry.exports).length : 'n/a');

  try {
    const src = fs.readFileSync(nodePath, 'utf8');
    const lines = src.split('\n');
    out('index.js bytes', `${src.length}  (intact reference: 4315)`);
    out('index.js lines', `${lines.length}  (intact reference: 93)`);
    out('last non-empty line', JSON.stringify(lines.filter((l) => l.trim()).pop()));
    for (const marker of ['__exportStar(require("@tensorflow/tfjs")', "registerBackend('tensorflow'", "setBackend('tensorflow')", 'registerLoadRouter']) {
      out(`contains ${marker.slice(0, 22)}`, String(src.includes(marker)));
    }
  } catch (err) {
    out('index.js read', `FAILED: ${err.message}`);
  }

  try {
    const union = require('@tensorflow/tfjs');
    out('tfjs enumerable keys', Object.keys(union).length);
    out('tfjs own props', Object.getOwnPropertyNames(union).length);
    const forIn = [];
    for (const k in union) forIn.push(k);
    // __exportStar copies with `for...in`; if that yields nothing while
    // Object.keys is full, the re-export was always going to come up empty.
    out('tfjs for..in count', forIn.length);
    const engine = union.engine ? union.engine() : null;
    out('registered backends', engine ? JSON.stringify(Object.keys(engine.registryFactory || {})) : 'n/a');
  } catch (err) {
    out('tfjs inspection', `FAILED: ${err.message}`);
  }
  console.error('');
}
