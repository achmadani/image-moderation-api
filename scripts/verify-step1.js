/* Step 1 verification: tfjs-node + nsfwjs + sharp smoke test */
const t0 = Date.now();
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const sharp = require('sharp');

(async () => {
  console.log('node           :', process.version, process.platform, process.arch);
  console.log('tf.version_core:', tf.version['tfjs-core']);
  console.log('tf.version     :', JSON.stringify(tf.version));
  console.log('backend        :', tf.getBackend());
  console.log('require time ms:', Date.now() - t0);

  // dummy image generated locally via sharp (solid colour block, no internet)
  const jpeg = await sharp({
    create: { width: 512, height: 384, channels: 3, background: { r: 200, g: 120, b: 90 } },
  }).jpeg({ quality: 90 }).toBuffer();
  const meta = await sharp(jpeg).metadata();
  console.log('dummy image    :', meta.format, meta.width + 'x' + meta.height, jpeg.length + ' bytes');

  const tLoad = Date.now();
  const model = await nsfw.load(); // bundled MobileNetV2, no network
  console.log('model loaded ms:', Date.now() - tLoad);

  // preprocess exactly like the service will: sharp -> raw RGB -> tensor
  const { data, info } = await sharp(jpeg)
    .removeAlpha().resize(224, 224, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  console.log('raw            :', info.width + 'x' + info.height + 'x' + info.channels, data.length + ' bytes');

  const tInf = Date.now();
  const input = tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
  let preds;
  try {
    preds = await model.classify(input);
  } finally {
    input.dispose();
  }
  console.log('inference ms   :', Date.now() - tInf);
  console.log('predictions    :', JSON.stringify(preds));
  console.log('tensors leaked :', tf.memory().numTensors, 'bytes', tf.memory().numBytes);
  console.log('rss MB         :', Math.round(process.memoryUsage().rss / 1048576));
  console.log('RESULT: OK');
})().catch((e) => { console.error('RESULT: FAIL'); console.error(e); process.exit(1); });
