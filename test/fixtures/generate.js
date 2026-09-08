'use strict';

/**
 * All test images are generated locally with sharp — solid colour blocks, no
 * bytes from the internet. Written to test/fixtures/generated/ on demand.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, 'generated');

const solid = (width, height, background) =>
  sharp({ create: { width, height, channels: 3, background } });

/** @returns {Promise<Record<string, Buffer>>} */
async function buildFixtures() {
  const red = { r: 200, g: 40, b: 40 };
  const green = { r: 40, g: 180, b: 90 };
  const blue = { r: 40, g: 90, b: 200 };

  const [jpeg, png, webp, gif, tiny, wide, huge] = await Promise.all([
    solid(512, 384, red).jpeg({ quality: 90 }).toBuffer(),
    solid(320, 320, green).png().toBuffer(),
    solid(256, 256, blue).webp().toBuffer(),
    solid(128, 128, red).gif().toBuffer(),
    solid(8, 8, green).png().toBuffer(),
    solid(1920, 200, blue).jpeg({ quality: 80 }).toBuffer(),
    // 9000x9000 = 81M pixels, above the default MAX_IMAGE_PIXELS of 50M.
    solid(9000, 9000, green).png({ compressionLevel: 9 }).toBuffer(),
  ]);

  return {
    'solid-red.jpg': jpeg,
    'solid-green.png': png,
    'solid-blue.webp': webp,
    'solid-red.gif': gif,
    'tiny.png': tiny,
    'wide.jpg': wide,
    'oversized.png': huge,
    'not-an-image.txt': Buffer.from('this is plain text, not an image at all\n'),
    // Valid PNG magic bytes followed by garbage: passes sniffing, fails decode.
    'corrupt.png': Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0x7f),
    ]),
  };
}

async function writeFixtures() {
  const fixtures = await buildFixtures();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, buf] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
  }
  return fixtures;
}

module.exports = { buildFixtures, writeFixtures, OUT_DIR };

if (require.main === module) {
  writeFixtures()
    .then((f) => {
      for (const [name, buf] of Object.entries(f)) console.log(name.padEnd(20), buf.length, 'bytes');
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
