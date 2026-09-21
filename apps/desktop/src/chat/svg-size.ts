/**
 * WHAT SIZE AN SVG DRAWS AT, off its opening tag — width/height, else the
 * viewBox — and whether that is small enough to sit in the thread as itself.
 * The renderer's copy of present-inline's reading (electron/pi/present-inline),
 * for the drawings that arrive as markup rather than through `present`.
 */

export function svgSize(markup: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(markup);
  if (open === null) return null;
  const tag = open[0];
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}="\\s*([\\d.]+)\\s*(?:px)?\\s*"`, 'i').exec(tag);
    if (m === null) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const viewBox = /\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(tag);
  const vbW = viewBox !== null ? Number(viewBox[1]) : null;
  const vbH = viewBox !== null ? Number(viewBox[2]) : null;
  const width = attr('width') ?? (vbW !== null && Number.isFinite(vbW) && vbW > 0 ? vbW : null);
  const height = attr('height') ?? (vbH !== null && Number.isFinite(vbH) && vbH > 0 ? vbH : null);
  if (width === null || height === null) return null;
  return { width, height };
}

/** Icon-sized and light: the drawing belongs beside the words. */
export function svgInlineSized(size: { width: number; height: number }, bytes: number): boolean {
  return bytes <= 64 * 1024 && Math.max(size.width, size.height) <= 512;
}

/** The size, bytes and — when it fits — the markup, for a presented card. */
export function svgCardPayload(
  markup: string,
): { width: number; height: number; bytes: number; text?: string } | undefined {
  const size = svgSize(markup);
  if (size === null) return undefined;
  const bytes = new TextEncoder().encode(markup).length;
  return { ...size, bytes, ...(svgInlineSized(size, bytes) ? { text: markup } : {}) };
}
