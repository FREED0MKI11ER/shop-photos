"use strict";

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) set(x, y, 0x0a, 0x0c, 0x0f);

  function roundRect(x0, y0, x1, y1, r, color) {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
        const cx = x < x0 + r ? x0 + r : x >= x1 - r ? x1 - r - 1 : x;
        const cy = y < y0 + r ? y0 + r : y >= y1 - r ? y1 - r - 1 : y;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) set(x, y, color[0], color[1], color[2]);
      }
    }
  }

  function circle(cx, cy, r, color) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) set(x, y, color[0], color[1], color[2]);
      }
    }
  }

  const purple = [0xa8, 0x55, 0xf7];
  const dark = [0x0a, 0x0c, 0x0f];
  const white = [0xff, 0xff, 0xff];

  const inset = Math.round(size * 0.07);
  roundRect(inset, inset, size - inset, size - inset, Math.round(size * 0.23), purple);

  const bw = Math.round(size * 0.54);
  const bh = Math.round(size * 0.38);
  const bx0 = Math.round((size - bw) / 2);
  const by0 = Math.round((size - bh) / 2 + size * 0.05);

  roundRect(
    Math.round(size / 2 - size * 0.11),
    by0 - Math.round(size * 0.075),
    Math.round(size / 2 + size * 0.03),
    by0 + Math.round(size * 0.02),
    Math.round(size * 0.02),
    white
  );
  roundRect(bx0, by0, bx0 + bw, by0 + bh, Math.round(size * 0.06), white);
  circle(size / 2, by0 + bh / 2, Math.round(size * 0.12), dark);
  circle(size / 2, by0 + bh / 2, Math.round(size * 0.055), purple);

  return buf;
}

const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  [192, "icon-192x192.png"],
  [512, "icon-512x512.png"],
  [180, "apple-touch-icon.png"],
];

for (const [size, name] of targets) {
  const png = encodePng(size, size, makeIcon(size));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log("wrote", name, `(${png.length} bytes)`);
}
