/**
 * THE PICTURE AS OMNISVG WAS TRAINED TO SEE IT — the authors'
 * `preprocess_image_for_svg` (OmniSVG inference.py), over raw pixels, so the
 * app does it before a picture leaves for llama-server:
 *
 *  1. transparency composited onto white. llama.cpp reads three channels and
 *     drops alpha, so a transparent icon's background became whatever colour
 *     its clear pixels held — black, for every one of the authors' own examples;
 *  2. a flat background that is not white made white (their
 *     `detect_and_replace_background`, same thresholds);
 *  3. 448 × 448 (config.yaml `image.target_size`), Lanczos as PIL resamples.
 *     At its own size a 1,000-px icon is 1,296 picture tokens (llama.cpp keeps
 *     up to 4,096) to a model fine-tuned on 256.
 *
 * One departure: a picture that is not square is padded to a square with white
 * where theirs is squashed, so a wide figure keeps its proportions. Their
 * examples are all square, so on those the two agree.
 */

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits a channel, alpha not premultiplied. */
  readonly data: Uint8Array;
}

/** config.yaml `image:` — the side, and `detect_and_replace_background`'s thresholds. */
export const OMNISVG_PICTURE_SIDE = 448;
const BACKGROUND_THRESHOLD = 240;
const EDGE_SAMPLE_RATIO = 0.1;
const MIN_EDGE_SAMPLES = 10;
const COLOR_SIMILARITY_THRESHOLD = 30;

const at = (data: Uint8Array, i: number): number => data[i] ?? 0;

/** Every pixel over opaque white (PIL `alpha_composite` onto a white ground). */
export function onWhite(p: Pixels): Pixels {
  const out = new Uint8Array(p.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = at(p.data, i + 3);
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.round((at(p.data, i + c) * a + 255 * (255 - a)) / 255);
    }
    out[i + 3] = 255;
  }
  return { width: p.width, height: p.height, data: out };
}

/**
 * Their `detect_and_replace_background`: sample the four edges; if they average
 * lighter than 240 in every channel the picture is left alone. Otherwise the
 * commonest edge colour is the background, and every pixel within 30 of it —
 * anywhere, not only connected to the edge — becomes white.
 */
export function withoutFlatBackground(p: Pixels): Pixels {
  const { width: w, height: h, data } = p;
  const px = (x: number, y: number): number => (y * w + x) * 4;
  const samples = Math.max(MIN_EDGE_SAMPLES, Math.floor(Math.min(w, h) * EDGE_SAMPLE_RATIO));
  const sum = [0, 0, 0];
  let n = 0;
  const add = (i: number): void => {
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + at(data, i + c);
    n += 1;
  };
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / samples))) {
    add(px(x, 0));
    add(px(x, h - 1));
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / samples))) {
    add(px(0, y));
    add(px(w - 1, y));
  }
  if (n === 0 || sum.every((s) => s / n > BACKGROUND_THRESHOLD)) return p;

  // The commonest exact colour on the edges; a tie goes to the first seen, as Counter does.
  const counts = new Map<number, number>();
  const tally = (i: number): void => {
    const key = (at(data, i) << 16) | (at(data, i + 1) << 8) | at(data, i + 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x += 1) {
    tally(px(x, 0));
    tally(px(x, h - 1));
  }
  for (let y = 0; y < h; y += 1) {
    tally(px(0, y));
    tally(px(w - 1, y));
  }
  let bg = 0;
  let most = -1;
  for (const [key, count] of counts) {
    if (count > most) {
      most = count;
      bg = key;
    }
  }
  const [br, bgr, bb] = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
  const out = Uint8Array.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const dr = at(data, i) - br;
    const dg = at(data, i + 1) - bgr;
    const db = at(data, i + 2) - bb;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < COLOR_SIMILARITY_THRESHOLD) {
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Padded with white to a square, the picture centred. */
export function squared(p: Pixels): Pixels {
  if (p.width === p.height) return p;
  const side = Math.max(p.width, p.height);
  const out = new Uint8Array(side * side * 4).fill(255);
  const ox = Math.floor((side - p.width) / 2);
  const oy = Math.floor((side - p.height) / 2);
  const row = p.width * 4;
  for (let y = 0; y < p.height; y += 1) {
    out.set(p.data.subarray(y * row, (y + 1) * row), ((y + oy) * side + ox) * 4);
  }
  return { width: side, height: side, data: out };
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos = (x: number): number => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);

/** PIL's `precompute_coeffs` for Lanczos: each output sample's first source index and weights. */
function taps(inSize: number, outSize: number): Array<{ start: number; weights: number[] }> {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = 3 * filterScale;
  const out: Array<{ start: number; weights: number[] }> = [];
  for (let o = 0; o < outSize; o += 1) {
    const centre = (o + 0.5) * scale;
    const start = Math.max(0, Math.trunc(centre - support + 0.5));
    const end = Math.min(inSize, Math.trunc(centre + support + 0.5));
    const weights: number[] = [];
    let total = 0;
    for (let x = start; x < end; x += 1) {
      const wt = lanczos((x - centre + 0.5) / filterScale);
      weights.push(wt);
      total += wt;
    }
    out.push({ start, weights: total === 0 ? weights : weights.map((wt) => wt / total) });
  }
  return out;
}

/** Resampled to `width` × `height` with PIL's Lanczos — across, then down. */
export function resized(p: Pixels, width: number, height: number): Pixels {
  const across = taps(p.width, width);
  const down = taps(p.height, height);
  const mid = new Float32Array(width * p.height * 4);
  for (let y = 0; y < p.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = across[x];
      if (t === undefined) continue;
      const o = (y * width + x) * 4;
      for (let k = 0; k < t.weights.length; k += 1) {
        const i = (y * p.width + t.start + k) * 4;
        const wt = t.weights[k] ?? 0;
        for (let c = 0; c < 4; c += 1) mid[o + c] = (mid[o + c] ?? 0) + at(p.data, i + c) * wt;
      }
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const t = down[y];
    if (t === undefined) continue;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let v = 0;
        for (let k = 0; k < t.weights.length; k += 1) {
          v += (mid[((t.start + k) * width + x) * 4 + c] ?? 0) * (t.weights[k] ?? 0);
        }
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { width, height, data: out };
}

/** A picture, ready for OmniSVG: on white, its flat background whitened, square, 448 × 448. */
export function omniSvgPicture(p: Pixels): Pixels {
  const square = squared(withoutFlatBackground(onWhite(p)));
  return square.width === OMNISVG_PICTURE_SIDE
    ? square
    : resized(square, OMNISVG_PICTURE_SIDE, OMNISVG_PICTURE_SIDE);
}

/** Where a prepared picture has ink — anything visibly darker than white — as fractions of its sides. */
export function contentBox(
  p: Pixels,
  threshold = 245,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = p.width;
  let y0 = p.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < p.height; y += 1) {
    for (let x = 0; x < p.width; x += 1) {
      const i = (y * p.width + x) * 4;
      if (
        at(p.data, i) < threshold ||
        at(p.data, i + 1) < threshold ||
        at(p.data, i + 2) < threshold
      ) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0: x0 / p.width, y0: y0 / p.height, x1: (x1 + 1) / p.width, y1: (y1 + 1) / p.height };
}
