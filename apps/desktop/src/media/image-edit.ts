/**
 * AN EDIT OF A PICTURE, as numbers and rules — no React, no IPC.
 *
 * The image viewer's Edit bar and the Image Studio's Edit are the same edit —
 * `gen:generate` with the picture as `inputImage` — so the three amounts, the
 * size the model is asked for and what a version is called live here once,
 * where both can read them and a test can pin them.
 */

/**
 * HOW FAR AN EDIT MAY TRAVEL FROM ITS PICTURE, 0..1 in the ordinary direction
 * (bigger = more different; worker.py inverts for mflux). Named amounts, not a
 * raw number, because the number is meaningless on its own — the Image
 * Studio's own three, so the two places that edit a picture cannot drift.
 */
export const EDIT_STRENGTHS = [
  { value: 0.3, label: 'Low', hint: 'Touch it up — same picture' },
  { value: 0.6, label: 'Medium', hint: 'Clearly reworked, still recognisable' },
  { value: 0.85, label: 'High', hint: 'Keeps the composition, redraws it' },
] as const;

export type EditStrength = (typeof EDIT_STRENGTHS)[number]['value'];

export const DEFAULT_EDIT_STRENGTH: EditStrength = 0.6;

/** The studio's smallest and largest long edges (ImageStudio SIZES). */
const MIN_LONG = 512;
const MAX_LONG = 1536;

/**
 * THE SIZE AN EDIT ASKS FOR — the picture's OWN shape.
 *
 * An edit that comes back a different shape is not the same picture any more:
 * the job is told a size (gen-manager always passes one), and a 16:9 frame asked
 * for at the default 1024² would come back square. So it is the source's own
 * width × height, on the model's 16px latent grid, with the long edge kept
 * inside the sizes the studio offers — a 4K photo is not a 4K job.
 */
export function editSize(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '1024x1024';
  const long = Math.max(width, height);
  const scale = long > MAX_LONG ? MAX_LONG / long : long < MIN_LONG ? MIN_LONG / long : 1;
  const snap = (n: number): number => Math.max(16, Math.round((n * scale) / 16) * 16);
  return `${snap(width)}x${snap(height)}`;
}

/** One picture in a viewer's history: the original, or an edit of one. */
export interface ImageVersion {
  readonly path: string;
  readonly name: string;
  /** What the History card calls it — "Original", or the words that made it. */
  readonly label: string;
}

/** The label an edit's version wears: the instruction, as typed, on one line. */
export function versionLabel(instruction: string): string {
  const oneLine = instruction.replace(/\s+/g, ' ').trim();
  return oneLine === '' ? 'Edit' : oneLine;
}

/** `pi:gen-<jobId>` → `<jobId>`: the id `gen:cancel` takes, or null. */
export function jobIdOfTab(tabId: string): string | null {
  return tabId.startsWith('pi:gen-') ? tabId.slice('pi:gen-'.length) : null;
}
