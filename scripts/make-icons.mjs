// Draws the app icons (PNG) used when the site is installed on a phone.
//
//   node scripts/make-icons.mjs
//
// No dependencies: shapes are rasterised with 4x4 anti-aliasing and written as PNG with zlib.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const ORANGE = [232, 89, 12];
const WHITE = [255, 255, 255];

// The logo, in a 32x32 design grid (same drawing as the favicon in index.html).
const STROKE = 2.4;
const WHEELS = [[10, 19, 5], [22, 19, 5]];
const SEGMENTS = [[10, 19, 14, 11], [14, 11, 20, 11], [20, 11, 22, 19], [14, 11, 12, 11]];

function segDist(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const onBike = (x, y) =>
  WHEELS.some(([cx, cy, r]) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= STROKE / 2) ||
  SEGMENTS.some((s) => segDist(x, y, s) <= STROKE / 2);

/**
 * size: output pixels. shape: 'circle' (transparent corners) or 'square' (full bleed).
 * bikeScale: how much of the canvas the 32-unit drawing spans (1 = edge to edge).
 */
function render(size, shape, bikeScale) {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  const unit = (size * bikeScale) / 32;           // pixels per design unit
  const off = (size - 32 * unit) / 2;             // centre the drawing
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          const inBg = shape === 'square' || Math.hypot(fx - size / 2, fy - size / 2) <= size * 15 / 32;
          if (!inBg) continue;
          const c = onBike((fx - off) / unit, (fy - off) / unit) ? WHITE : ORANGE;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (y * size + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return px;
}

// ---- PNG encoding -----------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, 'circle', 1],
  ['icon-512.png', 512, 'circle', 1],
  // Maskable: full-bleed background, drawing kept inside the central safe zone.
  ['icon-maskable-512.png', 512, 'square', 0.72],
  ['apple-touch-icon.png', 180, 'square', 0.8],
];
for (const [name, size, shape, scale] of icons) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, png(size, render(size, shape, scale)));
  console.log('•', name, fs.statSync(file).size, 'bytes');
}
