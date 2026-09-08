/* Extract the MobileNetV2 NSFW model bundled inside nsfwjs into a plain
 * TFJS layers-model directory (model.json + shard .bin) so the container can
 * load it from MODEL_PATH with file:// and never touch the network. */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.BAKE_MODEL || 'mobilenet_v2';
const SRC = path.join(__dirname, '..', 'node_modules', 'nsfwjs', 'dist', 'models', MODEL);
const OUT = path.join(__dirname, '..', 'model');

const unwrap = (m) => (m && m.default ? m.default : m);

const modelJson = unwrap(require(path.join(SRC, 'model.min.js')));
const manifest = modelJson.weightsManifest;
if (!Array.isArray(manifest) || manifest.length !== 1) {
  throw new Error(`unexpected weightsManifest shape: ${JSON.stringify(manifest && manifest.length)}`);
}

fs.mkdirSync(OUT, { recursive: true });

const paths = manifest[0].paths;
const written = [];
paths.forEach((p, i) => {
  const shardFile = path.basename(p, '.bin');
  const b64 = unwrap(require(path.join(SRC, `${shardFile}.min.js`)));
  if (typeof b64 !== 'string') throw new Error(`shard ${p} is not a base64 string`);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(OUT, `${shardFile}.bin`), buf);
  written.push([`${shardFile}.bin`, buf.length]);
  paths[i] = `${shardFile}.bin`;
});

fs.writeFileSync(path.join(OUT, 'model.json'), JSON.stringify(modelJson));
fs.writeFileSync(
  path.join(OUT, 'MODEL_INFO.json'),
  JSON.stringify({ source: `nsfwjs/dist/models/${MODEL}`, nsfwjsVersion: JSON.parse(fs.readFileSync(path.join(__dirname,'..','node_modules','nsfwjs','package.json'),'utf8')).version, modelVersion: 'nsfwjs-mobilenet-v2', inputSize: 224, bakedAt: new Date().toISOString() }, null, 2)
);

console.log('wrote model.json', fs.statSync(path.join(OUT, 'model.json')).size, 'bytes');
written.forEach(([f, n]) => console.log('wrote', f, n, 'bytes'));
