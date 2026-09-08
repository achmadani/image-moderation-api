'use strict';

/**
 * Resolves a usable TensorFlow.js namespace backed by the native CPU binding.
 *
 * Why this is not just `require('@tensorflow/tfjs-node')`:
 * tfjs-node writes only `version` and `io` onto its own exports. Every other
 * symbol — getBackend, tensor3d, zeros, memory — arrives via
 * `__exportStar(require('@tensorflow/tfjs'), exports)` at dist/index.js:77.
 * On some platform/Node combinations that re-export lands empty. The failure is
 * deceptive: libtensorflow still loads and prints its CPU banner, the backend
 * still registers, and only the namespace is unusable — so the process looks
 * healthy right up until the first `tf.` call throws "is not a function".
 *
 * Requiring tfjs-node is still mandatory for its side effects (it registers the
 * 'tensorflow' backend and calls setBackend on the shared core instance). We
 * just do not trust its re-export for the API surface.
 */

// Side effects only: registers and selects the native backend, and throws
// "Could not initialize TensorFlow backend." if the binding cannot be used.
const tfNode = require('@tensorflow/tfjs-node');

const REQUIRED = ['getBackend', 'tensor3d', 'zeros', 'memory', 'tidy'];

function safeRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

const isUsable = (ns) => Boolean(ns) && REQUIRED.every((fn) => typeof ns[fn] === 'function');

/** Candidates in preference order; all three share one core instance. */
const CANDIDATES = [
  ['@tensorflow/tfjs-node', tfNode],
  ['@tensorflow/tfjs', safeRequire('@tensorflow/tfjs')],
  ['@tensorflow/tfjs-core', safeRequire('@tensorflow/tfjs-core')],
];

function resolveNamespace() {
  for (const [name, ns] of CANDIDATES) {
    if (isUsable(ns)) return { namespace: name, tf: ns };
  }
  const detail = CANDIDATES
    .map(([name, ns]) => `${name}: ${ns ? `${Object.keys(ns).length} keys, missing [${REQUIRED.filter((f) => typeof ns[f] !== 'function').join(', ')}]` : 'not resolvable'}`)
    .join('; ');
  throw new Error(`No usable TensorFlow.js namespace found (${detail})`);
}

const { namespace, tf } = resolveNamespace();

/** tfjs-core carries no `version` object, so fall back to the package itself. */
function readVersion() {
  if (tf.version && tf.version['tfjs-core']) return tf.version['tfjs-core'];
  if (tfNode.version && tfNode.version['tfjs-core']) return tfNode.version['tfjs-core'];
  try {
    return require('@tensorflow/tfjs-core/package.json').version;
  } catch {
    return 'unknown';
  }
}

/**
 * Confirms the pieces tfjs-node installs at the END of its module body are
 * actually in place. If that body stops early — a truncated dist/index.js from
 * a half-extracted install is the way this happens — the require still
 * succeeds, libtensorflow still prints its CPU banner, and only these two
 * registrations are silently missing:
 *
 *   tf.registerBackend('tensorflow', ...) / tf.setBackend('tensorflow')
 *   tf.io.registerLoadRouter(nodeFileSystemRouter)   <- makes file:// work
 *
 * Failing here turns that into one clear message instead of a confusing
 * "Cannot find any save handlers for URL 'file://...'" when the model loads.
 */
async function ensureReady() {
  // getBackend() is undefined until the engine picks one, so force selection.
  await tf.ready();

  if (tf.getBackend() !== 'tensorflow') {
    try {
      await tf.setBackend('tensorflow');
      await tf.ready();
    } catch (err) {
      throw new Error(`could not select the native 'tensorflow' backend: ${err.message}`);
    }
  }

  const backend = tf.getBackend();
  if (backend !== 'tensorflow') {
    throw new Error(
      `@tensorflow/tfjs-node did not register the native backend (current backend: '${backend}'). ` +
      'Its module body did not run to completion — reinstall node_modules ' +
      '(docker build --no-cache) and check node_modules/@tensorflow/tfjs-node/dist/index.js is intact.'
    );
  }

  // The file:// router is registered on the very last lines of that same body.
  const handlers = tf.io.getLoadHandlers(`file://${__dirname}/model.json`);
  if (!handlers || handlers.length === 0) {
    throw new Error(
      "@tensorflow/tfjs-node did not register its file:// IO router, so MODEL_PATH cannot be loaded. " +
      'Its module body did not run to completion — reinstall node_modules (docker build --no-cache).'
    );
  }

  return { backend, namespace };
}

module.exports = {
  tf,
  namespace,
  ensureReady,
  tfVersion: readVersion(),
  /** Exposed for the build-time check and for diagnostics. */
  inspect: () => CANDIDATES.map(([name, ns]) => ({
    name,
    resolvable: Boolean(ns),
    keys: ns ? Object.keys(ns).length : 0,
    missing: ns ? REQUIRED.filter((f) => typeof ns[f] !== 'function') : REQUIRED,
  })),
};
