'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sniffMime, isPrivateAddress } = require('../../src/services/imageLoader');
const { buildFixtures } = require('../fixtures/generate');

test('sniffMime identifies each supported format from its magic bytes', async () => {
  const f = await buildFixtures();
  assert.strictEqual(sniffMime(f['solid-red.jpg']), 'image/jpeg');
  assert.strictEqual(sniffMime(f['solid-green.png']), 'image/png');
  assert.strictEqual(sniffMime(f['solid-blue.webp']), 'image/webp');
  assert.strictEqual(sniffMime(f['solid-red.gif']), 'image/gif');
});

test('sniffMime ignores the filename and rejects non-image bytes', async () => {
  const f = await buildFixtures();
  assert.strictEqual(sniffMime(f['not-an-image.txt']), null);
  // A .txt renamed to .png is still text; only the bytes are consulted.
  assert.strictEqual(sniffMime(Buffer.from('GIF but not really')), null);
});

test('sniffMime handles short and non-buffer input without throwing', () => {
  assert.strictEqual(sniffMime(Buffer.from([0xff, 0xd8])), null);
  assert.strictEqual(sniffMime(Buffer.alloc(0)), null);
  assert.strictEqual(sniffMime(null), null);
  assert.strictEqual(sniffMime('/tmp/x.jpg'), null);
});

test('sniffMime recognises BMP, AVIF and TIFF headers', () => {
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(20)]);
  assert.strictEqual(sniffMime(bmp), 'image/bmp');

  const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]);
  assert.strictEqual(sniffMime(avif), 'image/avif');

  // heic shares the ftyp box but is not an allowed brand here.
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  assert.strictEqual(sniffMime(heic), null);

  assert.strictEqual(sniffMime(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(16)])), 'image/tiff');
  assert.strictEqual(sniffMime(Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.alloc(16)])), 'image/tiff');
});

test('a RIFF container that is not WEBP is not accepted', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
  assert.strictEqual(sniffMime(wav), null);
});

test('isPrivateAddress blocks every range that could reach the host network', () => {
  for (const ip of [
    '127.0.0.1', '127.1.1.1', '0.0.0.0', '10.0.0.5', '192.168.1.1',
    '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:10.0.0.1',
  ]) {
    assert.strictEqual(isPrivateAddress(ip), true, `${ip} must be treated as private`);
  }
});

test('isPrivateAddress allows genuinely public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '99.99.99.99', '2606:4700::1111']) {
    assert.strictEqual(isPrivateAddress(ip), false, `${ip} must be treated as public`);
  }
});

test('isPrivateAddress treats anything that is not an IP as unsafe', () => {
  for (const value of ['example.com', '', 'not-an-ip', '999.1.1.1']) {
    assert.strictEqual(isPrivateAddress(value), true);
  }
});
