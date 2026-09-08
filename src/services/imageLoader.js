'use strict';

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const sharp = require('sharp');
const { fail } = require('../utils/errors');

const MAX_REDIRECTS = 3;

/**
 * MIME detection from magic bytes only. Rule #3: filenames and Content-Type
 * headers are attacker-controlled and are never consulted.
 * @param {Buffer} buf
 * @returns {string|null}
 */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';

  const head6 = buf.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';

  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';

  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  const tiffLe = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00;
  const tiffBe = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a;
  if (tiffLe || tiffBe) return 'image/tiff';

  return null;
}

/** Blocks SSRF into the host network: loopback, RFC1918, link-local, CGNAT, ULA. */
function isPrivateAddress(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (type === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) must be judged by the embedded v4 address.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/** Node's URL keeps the brackets on an IPv6 hostname; net and http both want it raw. */
const bareHost = (hostname) => hostname.replace(/^\[/, '').replace(/\]$/, '');

const isPixelLimitError = (err) => /pixel limit|limitInputPixels|too large/i.test(err.message || '');

class ImageLoader {
  /**
   * @param {import('../config')} config
   * @param {import('pino').Logger} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.allowedMime = new Set(config.allowedMime);
    this.allowlist = new Set(config.urlAllowlist.map((h) => h.toLowerCase()));
  }

  /** SHA-256 of the original bytes. Rule #8: the bytes themselves never hit disk. */
  hash(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Validates and normalises one image into the raw RGB tensor input.
   * @param {Buffer} buf original bytes
   * @returns {Promise<{raw: Buffer, hash: string, width: number, height: number, format: string, bytes: number}>}
   */
  async prepare(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw fail('NO_IMAGE_PROVIDED', 'Image payload is empty');
    }
    if (buf.length > this.config.maxUploadBytes) {
      throw fail('FILE_TOO_LARGE', `Image exceeds MAX_UPLOAD_BYTES (${this.config.maxUploadBytes} bytes)`, {
        bytes: buf.length,
        limit: this.config.maxUploadBytes,
      });
    }

    const mime = sniffMime(buf);
    if (!mime) {
      throw fail('UNSUPPORTED_MEDIA_TYPE', 'Payload is not a recognised image format');
    }
    if (!this.allowedMime.has(mime)) {
      throw fail('UNSUPPORTED_MEDIA_TYPE', `Media type ${mime} is not allowed`, {
        detected: mime,
        allowed: [...this.allowedMime],
      });
    }

    const size = this.config.modelInputSize;
    // limitInputPixels makes sharp refuse a decompression bomb before it
    // allocates the full bitmap, rather than after.
    const pipeline = sharp(buf, { limitInputPixels: this.config.maxImagePixels, animated: false, failOn: 'error' });

    let meta;
    try {
      meta = await pipeline.metadata();
    } catch (err) {
      // sharp enforces limitInputPixels while parsing the header, so a
      // decompression bomb fails here, before any decode is attempted.
      throw fail(
        isPixelLimitError(err) ? 'IMAGE_TOO_LARGE_DIMENSIONS' : 'DECODE_FAILED',
        isPixelLimitError(err)
          ? `Image exceeds MAX_IMAGE_PIXELS (${this.config.maxImagePixels})`
          : 'Image could not be decoded',
        { reason: err.message }
      );
    }

    if (!meta.width || !meta.height) {
      throw fail('DECODE_FAILED', 'Image has no readable dimensions');
    }
    if (meta.width * meta.height > this.config.maxImagePixels) {
      throw fail('IMAGE_TOO_LARGE_DIMENSIONS', `Image exceeds MAX_IMAGE_PIXELS (${this.config.maxImagePixels})`, {
        width: meta.width,
        height: meta.height,
        pixels: meta.width * meta.height,
        limit: this.config.maxImagePixels,
      });
    }

    let raw;
    let info;
    try {
      // rotate() applies EXIF orientation; raw output carries no metadata at
      // all, so this both normalises and strips in one pass.
      ({ data: raw, info } = await pipeline
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize(size, size, { fit: 'fill' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }));
    } catch (err) {
      const bomb = isPixelLimitError(err);
      throw fail(
        bomb ? 'IMAGE_TOO_LARGE_DIMENSIONS' : 'DECODE_FAILED',
        bomb ? `Image exceeds MAX_IMAGE_PIXELS (${this.config.maxImagePixels})` : 'Image could not be decoded',
        { reason: err.message }
      );
    }

    if (info.channels !== 3 || raw.length !== size * size * 3) {
      throw fail('DECODE_FAILED', 'Image did not normalise to 3-channel RGB', { channels: info.channels, bytes: raw.length });
    }

    return {
      raw,
      hash: this.hash(buf),
      width: meta.width,
      height: meta.height,
      format: meta.format || mime.replace('image/', ''),
      bytes: buf.length,
    };
  }

  /** @param {string} value base64, with or without a data: URI prefix */
  fromBase64(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw fail('INVALID_INPUT', 'base64 must be a non-empty string');
    }
    const payload = value.includes(',') && value.trim().startsWith('data:')
      ? value.slice(value.indexOf(',') + 1)
      : value;

    const cleaned = payload.trim();
    if (!/^[A-Za-z0-9+/\r\n=_-]+$/.test(cleaned)) {
      throw fail('INVALID_INPUT', 'base64 contains characters outside the base64 alphabet');
    }
    // Reject before allocating: 4 base64 chars decode to 3 bytes.
    if ((cleaned.length * 3) / 4 > this.config.maxUploadBytes * 1.1) {
      throw fail('FILE_TOO_LARGE', `Decoded image would exceed MAX_UPLOAD_BYTES (${this.config.maxUploadBytes} bytes)`);
    }

    const buf = Buffer.from(cleaned, 'base64');
    if (buf.length === 0) throw fail('INVALID_INPUT', 'base64 decoded to zero bytes');
    return buf;
  }

  /**
   * Fetches a remote image. Redirects are followed manually so every hop is
   * re-validated, and the socket is pinned to an address we already checked,
   * which closes the DNS-rebinding window.
   * @param {string} rawUrl
   * @returns {Promise<Buffer>}
   */
  async fromUrl(rawUrl) {
    if (!this.config.urlFetchEnabled) {
      throw fail('INVALID_INPUT', 'URL input is disabled (URL_FETCH_ENABLED=false)');
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw fail('INVALID_INPUT', 'url is not a valid URL');
    }

    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      this._assertUrlAllowed(current);
      const res = await this._request(current);
      if (res.redirectTo) {
        try {
          current = new URL(res.redirectTo, current);
        } catch {
          throw fail('URL_FETCH_FAILED', 'Redirect target is not a valid URL');
        }
        continue;
      }
      return res.body;
    }
    throw fail('URL_FETCH_FAILED', `Too many redirects (max ${MAX_REDIRECTS})`);
  }

  _assertUrlAllowed(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw fail('INVALID_INPUT', 'url must use http or https');
    }
    if (this.allowlist.size > 0) {
      if (!this.allowlist.has(url.hostname.toLowerCase())) {
        throw fail('URL_FETCH_FAILED', `Host ${url.hostname} is not in URL_ALLOWLIST`);
      }
      return; // an explicit allowlist may deliberately name an internal host
    }
    // Node connects straight to an IP literal without consulting dns.lookup, so
    // the lookup guard below never sees http://127.0.0.1/ or the cloud metadata
    // address. Literal hosts have to be checked here instead.
    const host = bareHost(url.hostname);
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw fail('URL_FETCH_FAILED', `Host ${host} is a private address`);
    }
  }

  /** @returns {Promise<{body?: Buffer, redirectTo?: string}>} */
  _request(url) {
    const { urlFetchTimeoutMs, maxUploadBytes } = this.config;
    const transport = url.protocol === 'https:' ? https : http;
    const allowPrivate = this.allowlist.size > 0; // an explicit allowlist may legitimately name an internal host

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: bareHost(url.hostname),
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { accept: 'image/*', 'user-agent': 'image-moderation/1.0' },
          timeout: urlFetchTimeoutMs,
          // Pin the connection to the address we validate here: node connects
          // to exactly this IP, so a second DNS answer cannot swap it out.
          lookup: (hostname, opts, cb) => {
            dns.lookup(hostname, { ...opts, all: false }, (err, address, family) => {
              if (err) return cb(err);
              if (!allowPrivate && isPrivateAddress(address)) {
                return cb(fail('URL_FETCH_FAILED', `Host ${hostname} resolves to a private address`));
              }
              return cb(null, address, family);
            });
          },
        },
        (res) => {
          const status = res.statusCode || 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve({ redirectTo: res.headers.location });
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(fail('URL_FETCH_FAILED', `Remote host returned HTTP ${status}`, { status }));
            return;
          }

          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxUploadBytes) {
            res.destroy();
            reject(fail('FILE_TOO_LARGE', `Remote image exceeds MAX_UPLOAD_BYTES (${maxUploadBytes} bytes)`, { bytes: declared }));
            return;
          }

          const chunks = [];
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            // Abort mid-stream: a lying Content-Length must not buy the caller
            // unbounded memory.
            if (received > maxUploadBytes) {
              res.destroy();
              reject(fail('FILE_TOO_LARGE', `Remote image exceeds MAX_UPLOAD_BYTES (${maxUploadBytes} bytes)`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
          res.on('error', (err) => reject(fail('URL_FETCH_FAILED', `Failed reading remote image: ${err.message}`)));
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(fail('URL_FETCH_FAILED', `Fetching the URL timed out after ${urlFetchTimeoutMs}ms`));
      });
      req.on('error', (err) => {
        reject(err.code && err.statusCode ? err : fail('URL_FETCH_FAILED', `Failed to fetch URL: ${err.message}`));
      });
      req.end();
    });
  }
}

module.exports = { ImageLoader, sniffMime, isPrivateAddress };
