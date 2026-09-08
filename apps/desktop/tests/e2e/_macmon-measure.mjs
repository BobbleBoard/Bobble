/**
 * Finding the drawn window on the computer-use monitor's canvas, from pixels.
 *
 * Both monitor probes need the same answer — where is the window, how big is
 * it, is one there at all — and both used to get it by scanning for BRIGHT
 * pixels. That only ever worked because the wallpaper behind the window was
 * dimmed 58% and blurred. It is now drawn as it is (the user: "don't blur the
 * wallpaper please"), and a sunlit sky, white sea foam and grey rock all clear
 * any brightness bar you can set. The measurement quietly grew to fit the whole
 * tab and three assertions about geometry started failing on a feature that had
 * not changed.
 *
 * So the window is found as the LARGEST CONNECTED REGION of window-ish pixels:
 *
 *   1. a pixel is window-ish if it is near-white AND colourless (a macOS window
 *      body is; a photograph almost never is, even where it is bright);
 *   2. those are flood-filled on a coarse grid into connected components;
 *   3. the biggest one is the window, and its bounding box is the answer.
 *
 * Connectivity is what makes this hold where a column- or row-coverage test
 * does not: a document full of dark text is still one connected sheet of paper,
 * and the window's own drop shadow is a dark moat that keeps it from merging
 * with a bright sky behind it. Whitecaps and pale rock form their own
 * components, and they are small.
 *
 * These functions are serialized into the page by `page.evaluate`, so they must
 * be entirely self-contained — no imports, no closure, no shared constants.
 */

/**
 * The drawn window's box in CANVAS DEVICE pixels, or null when none is drawn.
 * Runs in the page.
 */
export function measureDrawnWindow() {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null) return null;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  if (W === 0 || H === 0) return null;
  const d = ctx.getImageData(0, 0, W, H).data;
  const dpr = W / canvas.clientWidth;

  // Sample every 4th device pixel: a 4px hole cannot disconnect a window, and
  // it keeps the flood fill well under a frame's worth of work.
  const STEP = 4;
  const gw = Math.floor(W / STEP);
  const gh = Math.floor(H / STEP);
  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const i = (gy * STEP * W + gx * STEP) * 4;
      const lo = Math.min(d[i], d[i + 1], d[i + 2]);
      const hi = Math.max(d[i], d[i + 1], d[i + 2]);
      // The bar is 160 rather than 235 because the mock's document DIMS under
      // its save sheet; the colourless test is what keeps the wallpaper out.
      if (lo > 160 && hi - lo < 14) mask[gy * gw + gx] = 1;
    }
  }

  let best = null;
  const stack = new Int32Array(gw * gh);
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue;
    let top = 0;
    stack[top++] = start;
    mask[start] = 2;
    let size = 0;
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    while (top > 0) {
      const at = stack[--top];
      const x = at % gw;
      const y = (at - x) / gw;
      size += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[at - 1] === 1) {
        mask[at - 1] = 2;
        stack[top++] = at - 1;
      }
      if (x < gw - 1 && mask[at + 1] === 1) {
        mask[at + 1] = 2;
        stack[top++] = at + 1;
      }
      if (y > 0 && mask[at - gw] === 1) {
        mask[at - gw] = 2;
        stack[top++] = at - gw;
      }
      if (y < gh - 1 && mask[at + gw] === 1) {
        mask[at + gw] = 2;
        stack[top++] = at + gw;
      }
    }
    if (best === null || size > best.size) best = { size, minX, minY, maxX, maxY };
  }
  // A region smaller than this is a bright artefact, not a window.
  if (best === null || best.size < 400) return null;
  const w = (best.maxX - best.minX + 1) * STEP;
  const h = (best.maxY - best.minY + 1) * STEP;
  if (w < 60 || h < 60) return null;

  return {
    dpr,
    cssW: canvas.clientWidth,
    cssH: canvas.clientHeight,
    x: best.minX * STEP,
    y: best.minY * STEP,
    w,
    h,
  };
}

/**
 * Is the phantom cursor painted inside `box` (device pixels, from
 * {@link measureDrawnWindow})?
 *
 * The cursor is a pearl-white glyph with a faint lavender cast and a blue rim
 * glow — over the window's white paper it is the only thing that is bright AND
 * blue-leaning. Scoped to the window on purpose: searching the whole tab counted
 * the sea in a wallpaper of blue water and reported a cursor whatever was drawn.
 * Runs in the page; returns a sample count.
 */
export function countCursorPixels(box) {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null || box == null) return 0;
  const W = canvas.width;
  const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let hits = 0;
  for (let y = box.y; y < Math.min(H, box.y + box.h); y += 1) {
    for (let x = box.x; x < Math.min(W, box.x + box.w); x += 1) {
      const i = (y * W + x) * 4;
      if (d[i] > 170 && d[i + 2] > 200 && d[i + 2] - d[i] >= 8 && d[i + 2] - d[i] < 70) hits += 1;
    }
  }
  return hits;
}

/**
 * How much local detail survives in the four corners of the tab — the four
 * places only the wallpaper can be. A gaussian blur destroys exactly this, so
 * it is the measurement that proves the wallpaper is drawn as it is. Runs in
 * the page.
 */
export function measureWallpaperDetail() {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null) return 0;
  const W = canvas.width;
  const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const patch = (x0, y0) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y0 + 90 && y < H; y += 1) {
      for (let x = x0; x < x0 + 90 && x < W - 1; x += 1) {
        const a = (y * W + x) * 4;
        const b = (y * W + x + 1) * 4;
        sum += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]);
        n += 1;
      }
    }
    return n === 0 ? 0 : sum / n;
  };
  return Math.max(patch(4, 4), patch(W - 96, 4), patch(4, H - 96), patch(W - 96, H - 96));
}

/**
 * How much INK is inside `box` (device pixels, from {@link measureDrawnWindow})
 * — anything clearly darker than paper. A window drawn from Accessibility with
 * its controls and text on it has plenty; an empty white card has none, which
 * is the difference between "the fallback drew the app" and "the fallback drew
 * a rectangle". Runs in the page.
 */
export function countWindowInk(box) {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null || box == null) return 0;
  const W = canvas.width;
  const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let ink = 0;
  for (let y = box.y; y < Math.min(H, box.y + box.h); y += 2) {
    for (let x = box.x; x < Math.min(W, box.x + box.w); x += 2) {
      const i = (y * W + x) * 4;
      if (d[i] < 140 && d[i + 1] < 140 && d[i + 2] < 140) ink += 1;
    }
  }
  return ink;
}
