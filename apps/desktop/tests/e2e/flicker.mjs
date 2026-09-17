/**
 * FLICKER GUARD — catch a flash on screen, keep the frames, say what moved.
 *
 * the user (2026-09-16): "i'm noticing some flickering of charts on the screen
 * when you're running headed testing. might be harness artifacts, but it
 * might not be, add visual flicker guarding to ensure you catch when there's
 * flickering and get a frame of the flicker before and after and logging
 * attached so that you can fix these easily whenever they come up."
 *
 * A flicker is a change that REVERTS: frame A, then B, then A again within a
 * few frames — a card that unmounts and remounts, a chart that draws empty for
 * a frame, a hover state that bounces. A change that stays is not a flicker
 * (a chart appearing), and a change inside a View Transition is the animation
 * the app asked for. So the guard films the window over CDP (the same
 * screencast the transition probe uses), compares every frame with its
 * neighbours on a coarse grey grid, and when a region changes and changes
 * back it writes three PNGs (before / during / after), the region, and the
 * DOM mutations the page logged around that moment — the card that
 * disappeared is named by its data-testid, not guessed from pixels.
 *
 *   const guard = await watchFlicker(page, { dir: SHOT_DIR, label: 'edits' });
 *   … drive the app …
 *   const report = await guard.stop();   // { flickers: [...], frames, log }
 *
 * Pure Node: the PNG decoder below handles what Chromium's screencast emits
 * (8-bit RGB/RGBA, non-interlaced), so no image library is needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

export { decodePng } from './png.mjs';

/** The grid the frames are compared on (cells across); coarse on purpose. */
const GRID_W = 160;
/** A cell has "changed" when its mean grey moved by more than this (0–255). */
const CELL_DELTA = 14;
/** …and a frame has changed when at least this many cells did. */
const MIN_CELLS = 6;
/** A change that comes back within this many frames is a flicker… */
const REVERT_WITHIN = 4;
/**
 * …and within this much time. The screencast emits a frame only when
 * something changed, so "four frames" can span seconds: a tab closed and the
 * next one opened 1.3 s later read as a flicker (SEEN, office-embed probe —
 * the canvas panel closing and coming back). A flicker is fast by definition.
 */
const REVERT_WITHIN_MS = 500;
/** DOM mutations within this window of the flicker frame are attached. */
const DOM_WINDOW_MS = 400;

/** A frame reduced to a grey grid (GRID_W cells across, proportional down). */
export function greyGrid(png) {
  const cols = GRID_W;
  const rows = Math.max(1, Math.round((png.height / png.width) * GRID_W));
  const grid = new Float32Array(cols * rows);
  const cw = png.width / cols;
  const ch = png.height / rows;
  const { channels, data, width } = png;
  for (let r = 0; r < rows; r += 1) {
    const y0 = Math.floor(r * ch);
    const y1 = Math.max(y0 + 1, Math.floor((r + 1) * ch));
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.floor(c * cw);
      const x1 = Math.max(x0 + 1, Math.floor((c + 1) * cw));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * channels;
          sum +=
            channels >= 3 ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] : data[i];
          n += 1;
        }
      }
      grid[r * cols + c] = sum / n;
    }
  }
  return { cols, rows, grid };
}

/** The cells that differ between two grids, and their bounding box. */
export function gridDiff(a, b) {
  const cells = [];
  let minC = Number.POSITIVE_INFINITY;
  let minR = Number.POSITIVE_INFINITY;
  let maxC = -1;
  let maxR = -1;
  for (let i = 0; i < a.grid.length; i += 1) {
    if (Math.abs(a.grid[i] - b.grid[i]) > CELL_DELTA) {
      const c = i % a.cols;
      const r = Math.floor(i / a.cols);
      cells.push(i);
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  return {
    count: cells.length,
    bbox: cells.length > 0 ? { c0: minC, r0: minR, c1: maxC, r1: maxR } : null,
    cells,
  };
}

/**
 * Find the flickers in a sequence of grids: frame i differs from i-1 in a
 * region, and some frame j within REVERT_WITHIN after it looks like i-1 again
 * (most of the changed cells are back). Frames during a view transition are
 * skipped — that motion is on purpose.
 */
export function findFlickers(frames, transitions = []) {
  const out = [];
  const inTransition = (at) =>
    transitions.some((t) => at >= t.start - 20 && at <= (t.end ?? t.start + 1000) + 20);
  let i = 1;
  while (i < frames.length - 1) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (inTransition(cur.at)) {
      i += 1;
      continue;
    }
    const d = gridDiff(prev.grid, cur.grid);
    if (d.count < MIN_CELLS) {
      i += 1;
      continue;
    }
    let revertedAt = -1;
    for (let j = i + 1; j <= Math.min(frames.length - 1, i + REVERT_WITHIN); j += 1) {
      if (frames[j].at - cur.at > REVERT_WITHIN_MS) break;
      const back = gridDiff(prev.grid, frames[j].grid);
      const still = gridDiff(cur.grid, frames[j].grid);
      // Back to before (few cells differ from prev) after having been away
      // (many of the changed cells differ from the flicker frame).
      if (back.count <= Math.max(2, d.count * 0.2) && still.count >= d.count * 0.6) {
        revertedAt = j;
        break;
      }
    }
    if (revertedAt === -1) {
      i += 1;
      continue;
    }
    out.push({
      before: i - 1,
      during: i,
      after: revertedAt,
      cells: d.count,
      bbox: d.bbox,
      ms: frames[revertedAt].at - cur.at,
    });
    i = revertedAt + 1;
  }
  return out;
}

/** The in-page DOM log: mounts/unmounts of anything with a testid or class. */
const DOM_LOG_SCRIPT = `(() => {
  if (window.__flickerDom) return;
  const log = [];
  window.__flickerDom = log;
  const name = (n) => {
    if (!(n instanceof Element)) return null;
    const id = n.getAttribute('data-testid');
    const cls = n.getAttribute('class');
    return (id ? '#' + id : n.tagName.toLowerCase()) + (cls ? '.' + cls.split(/\\s+/).slice(0, 3).join('.') : '');
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        const s = name(n);
        if (s) log.push({ at: Date.now(), kind: 'add', node: s });
      }
      for (const n of m.removedNodes) {
        const s = name(n);
        if (s) log.push({ at: Date.now(), kind: 'remove', node: s });
      }
      if (m.type === 'attributes' && m.target instanceof Element) {
        const s = name(m.target);
        // State attributes anywhere (a clamp, a reveal, a live flag); style
        // and class only on the surfaces that animate, or the log is noise.
        const stateAttr = (m.attributeName || '').startsWith('data-') || m.attributeName === 'aria-expanded';
        if (s && (stateAttr || /chart|present|inline|canvas|chain|thought/.test(s))) {
          log.push({ at: Date.now(), kind: 'attr:' + m.attributeName + '=' + (m.target.getAttribute(m.attributeName) ?? ''), node: s });
        }
      }
      // Keep the last minute, not the last N entries: a long turn's churn
      // used to push the flicker's own mutations out of a fixed ring (SEEN:
      // 18 flickers reported with an empty dom list).
      const cutoff = Date.now() - 60000;
      if (log.length > 20000 || (log.length > 0 && log[0].at < cutoff)) {
        let k = 0;
        while (k < log.length && log[k].at < cutoff) k += 1;
        if (log.length - k > 20000) k = log.length - 20000;
        if (k > 0) log.splice(0, k);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-hover', 'data-chart-view', 'data-open', 'data-clamped', 'data-expanded', 'data-live', 'data-active', 'aria-expanded'] });
  window.__flickerTransitions = [];
  if (typeof document.startViewTransition === 'function' && !document.__flickerPatched) {
    document.__flickerPatched = true;
    const orig = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      const rec = { start: Date.now(), end: null };
      window.__flickerTransitions.push(rec);
      const t = orig(cb);
      t.finished.then(() => { rec.end = Date.now(); }, () => { rec.end = Date.now(); });
      return t;
    };
  }
})();`;

/**
 * Start filming. `stop()` analyses the frames, writes the evidence for every
 * flicker into `dir` and returns the report.
 */
export async function watchFlicker(page, { dir, label = 'flicker', maxWidth = 640 } = {}) {
  mkdirSync(dir, { recursive: true });
  await page.evaluate(DOM_LOG_SCRIPT);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let stopped = false;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const at = Date.now();
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (stopped) return;
    try {
      const png = decodePng(Buffer.from(data, 'base64'));
      frames.push({ at, data, grid: greyGrid(png) });
    } catch {
      /* a frame that cannot be decoded is not evidence of anything */
    }
  });
  await cdp.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth,
    maxHeight: Math.round(maxWidth * 0.75),
  });
  return {
    frames,
    async stop() {
      stopped = true;
      await cdp.send('Page.stopScreencast').catch(() => {});
      const dom = await page.evaluate(() => window.__flickerDom ?? []).catch(() => []);
      const transitions = await page
        .evaluate(() => window.__flickerTransitions ?? [])
        .catch(() => []);
      await cdp.detach().catch(() => {});
      const flickers = findFlickers(frames, transitions);
      const report = { label, frames: frames.length, flickers: [] };
      flickers.forEach((f, k) => {
        const stem = `flicker-${label}-${k + 1}`;
        for (const [which, idx] of [
          ['before', f.before],
          ['during', f.during],
          ['after', f.after],
        ]) {
          writeFileSync(
            path.join(dir, `${stem}-${which}.png`),
            Buffer.from(frames[idx].data, 'base64'),
          );
        }
        const at = frames[f.during].at;
        const nearby = dom.filter((m) => Math.abs(m.at - at) <= DOM_WINDOW_MS);
        const entry = {
          at: new Date(at).toISOString(),
          revertedAfterMs: f.ms,
          changedCells: f.cells,
          region: f.bbox,
          frames: {
            before: `${stem}-before.png`,
            during: `${stem}-during.png`,
            after: `${stem}-after.png`,
          },
          dom: nearby.map((m) => `${m.at - at > 0 ? '+' : ''}${m.at - at}ms ${m.kind} ${m.node}`),
        };
        report.flickers.push(entry);
      });
      writeFileSync(
        path.join(dir, `flicker-${label}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      return report;
    },
  };
}
