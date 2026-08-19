// 生成 build/icon.png（512x512，无第三方依赖）：深色圆角渐变 + 白色闪电
// 用法：node scripts/gen-icon.mjs
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

const FINAL = 512;   // 输出尺寸
const S = 1024;      // 超采样渲染尺寸（2x）

// ── 像素画布（RGBA，预乘无关，直接存直方图）───────────────────────────────
const img = new Float64Array(S * S * 4); // 直接存 RGBA 0-255
const R = 200; // 圆角半径（S 坐标系）

function inRoundedRect(x, y) {
  const cx = S / 2, cy = S / 2;
  const hw = S / 2 - R, hh = S / 2 - R;
  const dx = Math.max(Math.abs(x - cx) - hw, 0);
  const dy = Math.max(Math.abs(y - cy) - hh, 0);
  return dx * dx + dy * dy <= R * R;
}

// 垂直渐变背景：深藏青 → 深蓝
const top = [9, 15, 32], bottom = [30, 52, 102];
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const r = top[0] + (bottom[0] - top[0]) * t;
  const g = top[1] + (bottom[1] - top[1]) * t;
  const b = top[2] + (bottom[2] - top[2]) * t;
  for (let x = 0; x < S; x++) {
    if (!inRoundedRect(x, y)) continue;
    const i = (y * S + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
  }
}

// 白色闪电（S 坐标系坐标）
const bolt = [
  [660, 80], [260, 600], [470, 600], [350, 940],
  [790, 400], [550, 400], [670, 80],
];
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!pointInPoly(x, y, bolt)) continue;
    const i = (y * S + x) * 4;
    img[i] = 240; img[i + 1] = 244; img[i + 2] = 255; img[i + 3] = 255;
  }
}

// ── 2x2 下采样到 FINAL（按 alpha 预乘平均，避免黑边）──────────────────────
const out = Buffer.alloc(FINAL * FINAL * 4);
const step = S / FINAL;
for (let y = 0; y < FINAL; y++) {
  for (let x = 0; x < FINAL; x++) {
    let sumA = 0, sumR = 0, sumG = 0, sumB = 0;
    for (let dy = 0; dy < step; dy++) {
      for (let dx = 0; dx < step; dx++) {
        const sx = Math.min(S - 1, Math.floor(x * step + dx));
        const sy = Math.min(S - 1, Math.floor(y * step + dy));
        const i = (sy * S + sx) * 4;
        const a = img[i + 3];
        if (a === 0) continue;
        sumA += a;
        sumR += img[i] * a;
        sumG += img[i + 1] * a;
        sumB += img[i + 2] * a;
      }
    }
    const o = (y * FINAL + x) * 4;
    if (sumA === 0) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = Math.round(sumR / sumA);
    out[o + 1] = Math.round(sumG / sumA);
    out[o + 2] = Math.round(sumB / sumA);
    out[o + 3] = Math.round(sumA / (step * step));
  }
}

// ── PNG 编码 ────────────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG(FINAL, FINAL, out));
console.log(`已生成 ${OUT} (${FINAL}x${FINAL})`);
