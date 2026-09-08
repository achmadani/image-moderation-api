/* Confirm the baked model/ directory loads offline and matches the bundled model. */
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const sharp = require('sharp');

const MODEL_PATH = process.env.MODEL_PATH || path.join(__dirname, '..', 'model');

(async () => {
  const img = await sharp({ create: { width: 512, height: 384, channels: 3, background: { r: 200, g: 120, b: 90 } } })
    .jpeg({ quality: 90 }).toBuffer();
  const { data } = await sharp(img).removeAlpha().resize(224, 224, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });

  const classify = async (model) => {
    const x = tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
    try { return await model.classify(x); } finally { x.dispose(); }
  };

  const bundled = await classify(await nsfw.load());
  const baked = await classify(await nsfw.load(`file://${MODEL_PATH}/model.json`, { size: 224 }));

  console.log('bundled:', JSON.stringify(bundled));
  console.log('baked  :', JSON.stringify(baked));

  const maxDiff = Math.max(...bundled.map((b, i) => Math.abs(b.probability - baked[i].probability)));
  const sameOrder = bundled.every((b, i) => b.className === baked[i].className);
  console.log('sameOrder:', sameOrder, 'maxDiff:', maxDiff);
  if (!sameOrder || maxDiff > 1e-6) { console.error('RESULT: FAIL'); process.exit(1); }
  console.log('RESULT: OK');
})().catch((e) => { console.error('RESULT: FAIL'); console.error(e); process.exit(1); });
