'use strict';

/**
 * Why is `require('@tensorflow/tfjs-node').getBackend` missing?
 *
 * tfjs-node writes only `version` and `io` onto its exports directly; every
 * other symbol (getBackend, tensor3d, zeros, memory, ...) arrives via
 * `__exportStar(require('@tensorflow/tfjs'), exports)` at dist/index.js:77.
 * When that re-export produces nothing, the native binding still loads and the
 * backend still registers — which is exactly the symptom seen on the server.
 *
 * Run inside the built deps stage:
 *   docker build --platform linux/amd64 --target deps -t im-deps .
 *   docker run --rm -v "$PWD/scripts:/d:ro" im-deps node /d/diagnose-tfjs.js
 */

const fs = require('fs');
const path = require('path');

const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);

console.log('\n== runtime ==');
line('node', `${process.version} ${process.platform}/${process.arch}`);
line('cwd', process.cwd());
line('NODE_PATH', process.env.NODE_PATH || '(unset)');
line('NODE_OPTIONS', process.env.NODE_OPTIONS || '(unset)');

console.log('\n== installed packages ==');
for (const name of ['@tensorflow/tfjs-node', '@tensorflow/tfjs', '@tensorflow/tfjs-core']) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    line(name, `${pkg.version}  main=${pkg.main || '-'}  module=${pkg.module || '-'}  type=${pkg.type || 'commonjs'}`);
    if (pkg.exports) line(`  ${name} exports`, JSON.stringify(pkg.exports).slice(0, 160));
    line(`  ${name} path`, path.dirname(pkgPath));
  } catch (err) {
    line(name, `NOT RESOLVABLE: ${err.message}`);
  }
}

console.log('\n== export shape ==');
const probe = (name) => {
  try {
    const m = require(name);
    const keys = Object.keys(m);
    line(name, `keys=${keys.length}  getBackend=${typeof m.getBackend}  tensor3d=${typeof m.tensor3d}  memory=${typeof m.memory}  version=${typeof m.version}`);
    line(`  ${name} isNamespace`, String(m[Symbol.toStringTag] === 'Module'));
    line(`  ${name} first keys`, keys.slice(0, 8).join(', ') || '(none)');
    return m;
  } catch (err) {
    line(name, `THREW: ${err.message}`);
    return null;
  }
};

// Order matters: requiring tfjs-node first is what the app does.
const node = probe('@tensorflow/tfjs-node');
const union = probe('@tensorflow/tfjs');
const core = probe('@tensorflow/tfjs-core');

console.log('\n== backend ==');
const getBackend = (m) => {
  if (!m) return '(module missing)';
  if (typeof m.getBackend !== 'function') return '(getBackend not exported)';
  try { return m.getBackend(); } catch (err) { return `THREW: ${err.message}`; }
};
line('tfjs-node.getBackend()', getBackend(node));
line('tfjs.getBackend()', getBackend(union));
line('tfjs-core.getBackend()', getBackend(core));

console.log('\n== can the app actually run? ==');
const tf = (union && typeof union.tensor3d === 'function') ? union
  : (core && typeof core.tensor3d === 'function') ? core
  : (node && typeof node.tensor3d === 'function') ? node : null;

if (!tf) {
  console.log('  NO usable tf namespace found — inference is impossible in this image');
  process.exit(1);
}
try {
  const t = tf.zeros([2, 2, 3], 'int32');
  const sum = t.sum().dataSync()[0];
  t.dispose();
  line('zeros/sum/dispose', `ok (sum=${sum}, tensors left=${tf.memory().numTensors})`);
  line('usable namespace', tf === union ? '@tensorflow/tfjs' : tf === core ? '@tensorflow/tfjs-core' : '@tensorflow/tfjs-node');
} catch (err) {
  line('tensor op', `THREW: ${err.message}`);
  process.exit(1);
}
console.log('');
