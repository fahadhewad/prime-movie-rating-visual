/**
 * Generates the extension icons.
 *
 * They are drawn here rather than committed as opaque binaries so the ramp in
 * the icon stays the same ramp the extension paints - change the stops in
 * src/shared/color.js, re-run `npm run icons`, and the icon follows.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ratingToHue } from '../src/shared/color.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const STOPS = { low: 5.0, mid: 6.75, high: 8.5 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** hsl -> rgb, matching the ramp's 92% saturation / 52% lightness. */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectSdf(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const tileHalf = size * 0.36;
  const radius = size * 0.13;
  const aa = Math.max(0.8, size / 32);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const distance = roundedRectSdf(px, py, tileHalf, tileHalf, radius);

      // The tile face, carrying the rating ramp left to right.
      const face = 1 - smoothstep(-aa, aa, distance);
      // A halo outside it - the thing the extension actually draws.
      const halo = (1 - smoothstep(0, size * 0.14, distance)) * (distance > 0 ? 1 : 0);

      const t = Math.min(1, Math.max(0, (x + 0.5) / size));
      const rating = STOPS.low - 1 + t * (STOPS.high - STOPS.low + 2);
      const [r, g, b] = hslToRgb(ratingToHue(rating, STOPS), 0.92, 0.52);

      const alpha = Math.min(1, face + halo * 0.55);
      if (alpha <= 0.002) continue;

      // Darken the face slightly so the halo reads as the brighter element.
      const shade = face > 0.5 ? 0.82 : 1;
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(r * shade);
      rgba[offset + 1] = Math.round(g * shade);
      rgba[offset + 2] = Math.round(b * shade);
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of SIZES) {
  const path = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, draw(size));
  console.log(`wrote ${path}`);
}
