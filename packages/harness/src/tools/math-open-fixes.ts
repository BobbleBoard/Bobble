/**
 * THE PROBLEMS A MATHS PAGE WAS LAST DRAWN WITH, for the moment the model
 * presents it. MEASURED (the maths suite, 4B, round 4): simple harmonic motion
 * drawn with thirteen problems to fix — the mass under the view's floor, an
 * empty plot — and the very next call was `present`, whose answer ("it is
 * already open … reply in a sentence or two") ended the turn with a page that
 * showed neither. The math result had listed them; the call that decides the
 * turn is done is where they are heard. Once per draw: the second present
 * goes through, so a problem the model cannot fix is not a loop.
 */

const open = new Map<string, { fixes: readonly string[]; spec: string; pushed: boolean }>();

/** The draw of `page` (from `spec`) left these problems to fix (none clears it). */
export function noteDrawn(page: string, spec: string, fixes: readonly string[]): void {
  if (fixes.length === 0) open.delete(page);
  else open.set(page, { fixes, spec, pushed: false });
}

/** The problems to name when `page` is presented — once per draw — or null. */
export function fixesToPush(page: string): { fixes: readonly string[]; spec: string } | null {
  const o = open.get(page);
  if (o === undefined || o.pushed) return null;
  o.pushed = true;
  return { fixes: o.fixes, spec: o.spec };
}
