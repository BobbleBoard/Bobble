/**
 * THE MODEL'S LOOK AT A DOCUMENT IT MADE — the whole of it, in landscape.
 *
 * `present` used to hand back a photograph of the canvas editor at whatever
 * size the pane happened to be. MEASURED (4B, the visual suite, a 440-px
 * pane): an 8-slide deck came back as slide 1 at 29% zoom, a thin band in a
 * tall dark frame; a budget workbook as its first three columns. The model
 * checks its work against that picture, so it could not see slides 2–8 at
 * all, nor a column that ran off the edge.
 *
 * So the look is taken on an editor of its own (office-manager openLookView):
 * the same editor, on a hidden window at a landscape size, so nothing the
 * person sees moves. A deck is paged through and every slide photographed by
 * its own canvas, then laid out as one contact sheet in reading order; a
 * workbook, document or PDF is photographed wide. When any of that fails, the
 * caller falls back to the canvas photograph — a small look beats none.
 */
import { createLogger } from '@pi-desktop/shared';
import { type NativeImage, nativeImage, type WebContents } from 'electron';
import { officeKindForExt } from './office-contract';
import { type Cell, composeGrid, sheetColumns } from './office-grid';
import { openLookView } from './office-manager';

const log = createLogger('desktop:office-look');

/** The most slides a contact sheet shows; the note says when there are more. */
export const MAX_SHEET_SLIDES = 12;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function loaded(wc: WebContents, ms: number): Promise<void> {
  if (!wc.isLoading()) return;
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
    setTimeout(done, ms);
  });
}

/**
 * Where the slide itself is drawn. The slides editor draws each slide on a
 * Konva stage that is the slide plus a 160-px bleed all round
 * (vendor/genoffice …/SlideCanvas.tsx CANVAS_BLEED), scaled by a CSS transform
 * — so the stage's box is bigger than the view, and the slide is that box
 * inset by the bleed at the stage's scale. MEASURED: the stage's box was
 * 1764×1146 at (−21, −68) in a 1600×1000 view; the slide inside it,
 * 1411×794 at (155, 108). Else the page's largest canvas; null when neither.
 */
const STAGE_RECT = `(() => {
  const BLEED = 160;
  const clamp = (r) => {
    const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
    const w = Math.min(innerWidth - x, Math.round(r.x + r.width) - x);
    const h = Math.min(innerHeight - y, Math.round(r.y + r.height) - y);
    return w >= 80 && h >= 60 ? { x, y, width: w, height: h } : null;
  };
  let stage = null;
  for (const el of document.querySelectorAll('.konvajs-content')) {
    if (!stage || el.offsetWidth * el.offsetHeight > stage.offsetWidth * stage.offsetHeight) stage = el;
  }
  if (stage && stage.offsetWidth > 2 * BLEED && stage.offsetHeight > 2 * BLEED) {
    const r = stage.getBoundingClientRect();
    const k = r.width / stage.offsetWidth;
    return clamp({ x: r.x + BLEED * k, y: r.y + BLEED * k,
      width: (stage.offsetWidth - 2 * BLEED) * k, height: (stage.offsetHeight - 2 * BLEED) * k });
  }
  let best = null;
  for (const el of document.querySelectorAll('canvas')) {
    const b = clamp(el.getBoundingClientRect());
    if (b && (!best || b.width * b.height > best.width * best.height)) best = b;
  }
  return best;
})()`;

/** How many slides the editor says the deck has ("Slide 1 of 8"). */
const SLIDE_COUNT = `(() => {
  const m = /Slide\\s+\\d+\\s+of\\s+(\\d+)/.exec(document.body.innerText || '');
  return m ? Number(m[1]) : 0;
})()`;

async function shoot(
  wc: WebContents,
  rect?: { x: number; y: number; width: number; height: number },
): Promise<NativeImage | null> {
  const img = await (rect === undefined ? wc.capturePage() : wc.capturePage(rect));
  return img.isEmpty() ? null : img;
}

export interface OfficeLook {
  readonly dataUrl: string;
  /** What the picture is, for the text beside it. */
  readonly note: string;
}

/**
 * The model's look at the office file at `filePath`, or null when there is no
 * editor for it or it would not draw.
 */
export async function officeLook(filePath: string): Promise<OfficeLook | null> {
  const kind = officeKindForExt(filePath.split('.').pop() ?? '');
  if (kind === null || kind === 'markdown') return null;
  const size =
    kind === 'slides'
      ? { width: 1600, height: 1000 }
      : kind === 'sheets'
        ? { width: 1600, height: 1000 }
        : { width: 1200, height: 1400 };
  const look = openLookView(kind, filePath, size);
  if (look === null) return null;
  const wc = look.view.webContents;
  try {
    await loaded(wc, 12_000);
    // The editors lay the document out after load.
    await sleep(1_800);
    if (kind !== 'slides') {
      const img = await shoot(wc);
      if (img === null) return null;
      const wide = img.getSize().width > 1400 ? img.resize({ width: 1400, quality: 'best' }) : img;
      return {
        dataUrl: wide.toDataURL(),
        note:
          kind === 'sheets'
            ? 'The capture is the first sheet, opened wide.'
            : 'The capture is the first page, opened wide.',
      };
    }
    const count = Number(await wc.executeJavaScript(SLIDE_COUNT, true).catch(() => 0)) || 1;
    const shown = Math.min(count, MAX_SHEET_SLIDES);
    const cols = sheetColumns(shown);
    // Each slide at most this wide on the sheet, so the whole sheet stays ~1.3k.
    const cellW = Math.floor((1320 - (cols + 1) * 12) / cols);
    const cells: Cell[] = [];
    for (let i = 0; i < shown; i += 1) {
      await wc
        .executeJavaScript(`window.__pdViewState?.set?.({ slide: ${i} })`, true)
        .catch(() => undefined);
      await sleep(i === 0 ? 400 : 300);
      const rect = await wc.executeJavaScript(STAGE_RECT, true).catch(() => null);
      if (i === 0) log.info('office look: slide box', { rect, count });
      const img = await shoot(wc, rect ?? undefined);
      if (img === null) continue;
      const fit = img.resize({ width: Math.min(cellW, img.getSize().width), quality: 'best' });
      const { width, height } = fit.getSize();
      cells.push({ data: fit.toBitmap(), width, height });
    }
    if (cells.length === 0) return null;
    const sheet = composeGrid(cells, { cols, gap: 12, background: [40, 40, 44] });
    const png = nativeImage.createFromBitmap(sheet.data, {
      width: sheet.width,
      height: sheet.height,
    });
    const more = count > shown ? ` (the first ${shown} of ${count})` : '';
    return {
      dataUrl: png.toDataURL(),
      note:
        cells.length === 1
          ? 'The capture is the slide.'
          : `The capture shows every slide${more}, in order — left to right, then down.`,
    };
  } catch {
    return null;
  } finally {
    look.close();
  }
}

/* A probe's handle on the look (office-look-probe.mjs), in main where the
   editors live — only in an e2e run. */
if (process.env.PI_E2E === '1') {
  (globalThis as { __pdOfficeLook?: typeof officeLook }).__pdOfficeLook = officeLook;
}
