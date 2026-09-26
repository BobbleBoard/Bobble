/**
 * A contact sheet's layout, as pixels — the pure half of office-look.ts, so
 * it is tested without Electron.
 */

/** One picture as raw BGRA (Electron's `toBitmap`). */
export interface Cell {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Lay `cells` out in reading order on a grid of `cols` columns, every cell in
 * a slot the size of the largest one, `gap` pixels apart on a `background`
 * ground. Pure: BGRA in, BGRA out.
 */
export function composeGrid(
  cells: readonly Cell[],
  opts: { cols: number; gap: number; background: readonly [number, number, number] },
): Cell {
  const cols = Math.max(1, Math.min(opts.cols, cells.length));
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const slotW = Math.max(1, ...cells.map((c) => c.width));
  const slotH = Math.max(1, ...cells.map((c) => c.height));
  const width = cols * slotW + (cols + 1) * opts.gap;
  const height = rows * slotH + (rows + 1) * opts.gap;
  const out = Buffer.alloc(width * height * 4);
  const [r, g, b] = opts.background;
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = b;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = r;
    out[i * 4 + 3] = 255;
  }
  cells.forEach((c, n) => {
    const x0 = opts.gap + (n % cols) * (slotW + opts.gap) + Math.floor((slotW - c.width) / 2);
    const y0 =
      opts.gap + Math.floor(n / cols) * (slotH + opts.gap) + Math.floor((slotH - c.height) / 2);
    for (let y = 0; y < c.height; y += 1) {
      c.data.copy(out, ((y0 + y) * width + x0) * 4, y * c.width * 4, (y + 1) * c.width * 4);
    }
  });
  return { data: out, width, height };
}

/**
 * Is this region of a BGRA picture all one near-white? `scale` maps the
 * region's page pixels onto the picture's (a capture at 2× device pixels).
 */
export function regionIsBlank(
  pic: Cell,
  box: { x: number; y: number; width: number; height: number },
  scale: number,
): boolean {
  const x0 = Math.max(0, Math.floor(box.x * scale));
  const y0 = Math.max(0, Math.floor(box.y * scale));
  const x1 = Math.min(pic.width, Math.ceil((box.x + box.width) * scale));
  const y1 = Math.min(pic.height, Math.ceil((box.y + box.height) * scale));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * pic.width + x) * 4;
      // BGRA: anything visibly darker than the white cell is a drawn mark.
      if (
        (pic.data[i] ?? 255) < 235 ||
        (pic.data[i + 1] ?? 255) < 235 ||
        (pic.data[i + 2] ?? 255) < 235
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Columns for a contact sheet of `n` slides: two up to four, then three. */
export function sheetColumns(n: number): number {
  return n <= 1 ? 1 : n <= 4 ? 2 : 3;
}
