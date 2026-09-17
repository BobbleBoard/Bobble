/**
 * PNG in, PNG out — enough of the format for the probes (decode what Chromium
 * emits, crop a region, encode it back), with no image library.
 *
 * Why crop at all: Playwright's element screenshot on an Electron page has no
 * viewport to fit, so it captures "beyond the viewport" — Chromium re-lays the
 * document out to the clip for a frame, and the window FLASHES. MEASURED by
 * flicker.mjs: ten flashes in one probe, one per card screenshot. A full-page
 * screenshot has no such step, so a card is cut out of one here instead.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** Decode a non-interlaced 8-bit PNG (grey / RGB / RGBA, with or without alpha). */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, interlace ${interlace})`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let inPos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[inPos];
    inPos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[inPos + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let val;
      switch (filter) {
        case 0:
          val = v;
          break;
        case 1:
          val = v + a;
          break;
        case 2:
          val = v + b;
          break;
        case 3:
          val = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[rowStart + x] = val & 0xff;
    }
    inPos += stride;
  }
  return { width, height, channels, data: out };
}

const CRC_TABLE = new Uint32Array(256).map((_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit pixels (1, 2, 3 or 4 channels) as a PNG. */
export function encodePng({ width, height, channels, data }) {
  const colourType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  if (colourType === undefined) throw new Error(`cannot encode ${channels} channels`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0;
    data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Cut a rectangle (in pixels) out of a PNG buffer and return it as a PNG. */
export function cropPng(buf, { x, y, width, height }) {
  const png = decodePng(buf);
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const w = Math.max(1, Math.min(png.width - x0, Math.round(width)));
  const h = Math.max(1, Math.min(png.height - y0, Math.round(height)));
  const out = Buffer.alloc(w * h * png.channels);
  for (let row = 0; row < h; row += 1) {
    const from = ((y0 + row) * png.width + x0) * png.channels;
    png.data.copy(out, row * w * png.channels, from, from + w * png.channels);
  }
  return encodePng({ width: w, height: h, channels: png.channels, data: out });
}

/**
 * Paste `overlay` (a PNG) onto `base` (a PNG) with its top-left at (x, y)
 * pixels — the DOM screenshot with a native view's capture laid over its
 * bounds is what the screen actually shows, since Playwright cannot see a
 * WebContentsView and `office:capture` / `browser:capture` cannot see the DOM.
 * Nearest-neighbour scaled when the overlay's size differs from the box.
 */
export function compositePng(base, overlay, { x, y, width, height }) {
  const a = decodePng(base);
  const b = decodePng(overlay);
  const out = Buffer.from(a.data);
  const w = Math.round(width ?? b.width);
  const h = Math.round(height ?? b.height);
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  for (let row = 0; row < h; row += 1) {
    const ty = y0 + row;
    if (ty < 0 || ty >= a.height) continue;
    const sy = Math.min(b.height - 1, Math.floor((row * b.height) / h));
    for (let col = 0; col < w; col += 1) {
      const tx = x0 + col;
      if (tx < 0 || tx >= a.width) continue;
      const sx = Math.min(b.width - 1, Math.floor((col * b.width) / w));
      const si = (sy * b.width + sx) * b.channels;
      const ti = (ty * a.width + tx) * a.channels;
      for (let c = 0; c < Math.min(3, a.channels); c += 1) {
        out[ti + c] = b.channels >= 3 ? b.data[si + c] : b.data[si];
      }
      if (a.channels === 4) out[ti + 3] = 255;
    }
  }
  return encodePng({ width: a.width, height: a.height, channels: a.channels, data: out });
}
