/**
 * THE SHAPE OF A PICTURE THE APP HAS ALREADY SEEN, BY PATH.
 *
 * A generated picture is decoded twice at the handover: once by the waiting card
 * that sweeps it in, then again by the finished card that replaces it. The second
 * `<img>` has no size until its own decode lands, so for a frame the finished
 * card was a 200px box between two 482px ones (MEASURED 2026-09-24, one frame at
 * the swap). The waiting card records the shape it decoded; the finished card
 * holds that box until its own copy is ready, so the swap is not seen.
 */
const SHAPES = new Map<string, number>();
const CAP = 200;

export function rememberShape(path: string, aspect: number): void {
  if (!Number.isFinite(aspect) || aspect <= 0) return;
  SHAPES.delete(path);
  SHAPES.set(path, aspect);
  if (SHAPES.size > CAP) {
    const oldest = SHAPES.keys().next().value;
    if (oldest !== undefined) SHAPES.delete(oldest);
  }
}

export function shapeOf(path: string): number | undefined {
  return SHAPES.get(path);
}
