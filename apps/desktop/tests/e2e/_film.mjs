/**
 * FILMING A BUILD — what the eye gets while a card builds itself, and whether
 * the page kept up.
 *
 *  - `startFilm`: the CDP screencast, compositor frames with their own
 *    timestamps (page.screenshot is far too slow to film a 200 ms animation —
 *    see sidebar-close-probe);
 *  - `startFrameLog` / `readFrameLog`: every requestAnimationFrame delta and
 *    the page's long tasks, for "never block the UI thread";
 *  - `filmstrip`: frames ~every `stepMs`, cut to one box, laid out as a grid
 *    with their times under them — one image to look at.
 *
 * A hidden probe window is still driven at the display's rate here (MEASURED
 * 2026-09-25: median 8.3 ms between frames, a 120 Hz panel), so the deltas
 * are the real ones.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchChromium } from '../../../../tools/visual-eval/lib/env.mjs';
import { cropPng } from './png.mjs';

/** Start the screencast on `page`; `stop()` ends it, `frames` fills as it runs. */
export async function startFilm(app, page) {
  const cdp = await app.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
    } catch {
      /* stopped */
    }
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
    },
  };
}

/** Log every animation frame's delta, and the long tasks, until readFrameLog. */
export function startFrameLog(page) {
  return page.evaluate(() => {
    const log = { deltas: [], long: [], work: [] };
    let last = performance.now();
    const tick = (now) => {
      log.deltas.push(Math.round((now - last) * 10) / 10);
      last = now;
      if (!log.stopped) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) log.long.push(Math.round(e.duration));
      });
      po.observe({ type: 'longtask', buffered: false });
      log.po = po;
    } catch {
      /* no long-task timing here */
    }
    window.__pdFrameLog = log;
  });
}

/** The deltas and long tasks since startFrameLog, and a summary of them. */
export async function readFrameLog(page) {
  const log = await page.evaluate(() => {
    const l = window.__pdFrameLog;
    l.stopped = true;
    l.po?.disconnect();
    return { deltas: l.deltas, long: l.long };
  });
  const sorted = [...log.deltas].sort((a, b) => b - a);
  return {
    ...log,
    summary: {
      frames: log.deltas.length,
      longestMs: sorted[0] ?? null,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
      over20ms: log.deltas.filter((d) => d > 20).length,
      over34ms: log.deltas.filter((d) => d > 34).length,
      longTasks: log.long,
    },
  };
}

/**
 * Frames ~every `stepMs` from the film, each cut to `clip` (CSS pixels of a
 * `viewportWidth`-wide window — a frame's own scale is read from its width),
 * written to `dir/frames/` and laid out in `dir/<name>.png`.
 */
export async function filmstrip(
  frames,
  {
    dir,
    name = 'filmstrip',
    clip,
    viewportWidth,
    stepMs = 100,
    cols = 8,
    cellWidth = 220,
    from,
    to,
  },
) {
  const pool = frames.filter(
    (f) => (from === undefined || f.t >= from) && (to === undefined || f.t <= to),
  );
  const picked = [];
  if (pool.length > 0) {
    const start = pool[0].t;
    const end = pool.at(-1).t;
    for (let at = start; at <= end + 1; at += stepMs) {
      let best = pool[0];
      for (const f of pool) if (Math.abs(f.t - at) < Math.abs(best.t - at)) best = f;
      if (picked.at(-1) !== best) picked.push(best);
    }
  }
  const frameDir = path.join(dir, `${name}-frames`);
  mkdirSync(frameDir, { recursive: true });
  const files = picked.map((f, i) => {
    const buf = Buffer.from(f.data, 'base64');
    const scale = buf.readUInt32BE(16) / viewportWidth;
    const file = path.join(frameDir, `${String(i).padStart(3, '0')}.png`);
    writeFileSync(
      file,
      clip
        ? cropPng(buf, {
            x: clip.x * scale,
            y: clip.y * scale,
            width: clip.width * scale,
            height: clip.height * scale,
          })
        : buf,
    );
    return { file, t: Math.round(f.t - picked[0].t) };
  });
  if (files.length === 0) return { files, sheet: null };
  const browser = await launchChromium();
  const sheet = path.join(dir, `${name}.png`);
  try {
    const cells = files
      .map(
        (f) =>
          `<figure><img src="data:image/png;base64,${readFileSync(f.file).toString('base64')}"><figcaption>${f.t} ms</figcaption></figure>`,
      )
      .join('');
    const html = `<!doctype html><html><body style="margin:0;background:#dddcd8;font:12px -apple-system,sans-serif">
      <div style="display:grid;grid-template-columns:repeat(${cols},${cellWidth}px);gap:6px;padding:8px">${cells}</div>
      <style>figure{margin:0;background:#fff}img{width:${cellWidth}px;display:block}figcaption{padding:2px 4px;color:#333}</style></body></html>`;
    const page = await browser.newPage({
      viewport: { width: cols * (cellWidth + 6) + 16, height: 400 },
      deviceScaleFactor: 2,
    });
    await page.setContent(html);
    await page.screenshot({ path: sheet, fullPage: true });
  } finally {
    await browser.close();
  }
  return { files, sheet };
}
