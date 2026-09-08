/**
 * AN EDIT IS AN EDIT, NOT A DIFF BEING WRITTEN.
 *
 * the user: "Editing a file shouldn't show the diff being written in real time it
 * should show that file and then the text as the negative part of the diff is
 * written being deleted (forward delete I suppose, but still deleting live just
 * like there's a live writing animation) and then of course the replace part
 * writing animation same as when it's writing just in the file wherever it is.
 * this should ideally be a smooth line deleting and then typing occuring again
 * starting right where the delete ended."
 *
 * This module is the SCHEDULE for that motion — the whole of it, and none of the
 * DOM. Given the file as it stood before the edit and the hunks the tool is
 * applying, it produces the text the buffer should hold at any point in time,
 * plus the caret that text is being changed at. A driver samples it on each
 * animation frame and hands the result to the same
 * {@link ../surfaces/code-append.ts streamingUpdateSpec} reconcile a file being
 * WRITTEN goes through, so a write and an edit are the same hand: text arriving
 * in the buffer over time, minimal changes, no viewport yanking, no second
 * animation system.
 *
 * The motion per hunk is deliberately two beats and one caret:
 *   1. FORWARD DELETE — the caret parks at the start of the replaced span and
 *      the text after it is eaten. The caret does not move; the file closes up.
 *   2. TYPE — the replacement grows from that same offset. Which is why "typing
 *      starts exactly where the delete ended" is not a special case here: it is
 *      the only place it *could* start.
 *
 * Everything below is pure and synchronous so the ordering, the schedule, the
 * duration cap and the reduced-motion path are unit-testable without a DOM.
 */

/** A replacement as the tool describes it: this text becomes that text. */
export interface EditHunkInput {
  /** The replaced text (`old_string`). Absent/empty → a pure insertion. */
  oldText?: string;
  /** The replacement (`new_string`). Absent/empty → a pure deletion. */
  newText?: string;
  /**
   * Offset in the base text to apply at, when the caller already knows it.
   * Required for an insertion (empty `oldText` can be found anywhere, so it can
   * be found nowhere); ignored when `oldText` is non-empty and locatable.
   */
  at?: number;
}

/** A hunk that has been located in the base text and given its slice of time. */
export interface AnimatedHunk {
  /** Offset in the BASE text where the replaced span begins. */
  at: number;
  oldText: string;
  newText: string;
  /** ms from the plan's start at which this hunk's forward-delete begins. */
  startMs: number;
  /** ms spent forward-deleting `oldText` (0 when there is nothing to delete). */
  deleteMs: number;
  /** ms spent typing `newText` (0 when there is nothing to type). */
  typeMs: number;
  /** Stillness after this hunk, before the next one starts. 0 on the last. */
  beatMs: number;
}

export interface EditAnimationPlan {
  /** The file as it stood before the edit. */
  baseText: string;
  /** The file once every hunk has been applied. */
  finalText: string;
  /** Located hunks in DOCUMENT order (top of the file first). */
  hunks: AnimatedHunk[];
  /** Stillness at the start, while the view settles on the first edit site. */
  settleMs: number;
  /** Total run length including `settleMs` and the trailing hunk's typing. */
  totalMs: number;
  /**
   * Nothing to animate — a driver must render {@link finalText} at once. True
   * under reduced motion, for a no-op edit, and for a file too large to rebuild
   * per frame.
   */
  instant: boolean;
}

export type EditPhase = 'settle' | 'delete' | 'type' | 'beat' | 'done';

export interface EditFrame {
  /** What the buffer should hold right now. */
  text: string;
  /**
   * Where the change is happening in `text`: during a delete, the fixed point
   * the text is being eaten forward from; during a type, the growing end of the
   * replacement. A driver keeps this visible.
   */
  caret: number;
  phase: EditPhase;
  /** Index into {@link EditAnimationPlan.hunks}; -1 while settling and at rest. */
  hunk: number;
}

/**
 * THE HAND. One cadence for deleting and one for typing, chosen to sit in the
 * same range a local model's write stream lands in (tens of tokens a second),
 * because that is the animation this one has to feel like.
 *
 * The caps are the legibility budget: past them a phase stops being read
 * character by character and becomes a wipe, so a 4,000-character replacement
 * finishes in {@link maxPhaseMs} rather than in twenty seconds. Fidelity is not
 * the point; seeing that the file changed, and where, is.
 */
export interface EditAnimationOptions {
  /** Skip the motion entirely (`prefers-reduced-motion`, hidden tab, …). */
  reducedMotion?: boolean;
  /** Characters per second while forward-deleting. */
  deleteCps?: number;
  /** Characters per second while typing the replacement. */
  typeCps?: number;
  /** Stillness before the first delete, for the scroll to land. */
  settleMs?: number;
  /** Stillness between one hunk and the next. */
  beatMs?: number;
  /** Floor for a non-empty phase, so a three-character edit is still a motion. */
  minPhaseMs?: number;
  /** Ceiling for one delete or one type. */
  maxPhaseMs?: number;
  /** Ceiling for the whole run; every duration scales down together past it. */
  maxTotalMs?: number;
}

export const EDIT_ANIMATION_DEFAULTS = {
  deleteCps: 320,
  typeCps: 200,
  settleMs: 260,
  beatMs: 180,
  minPhaseMs: 90,
  maxPhaseMs: 1400,
  maxTotalMs: 5200,
} as const;

/**
 * Files above this many characters settle instead of animating. Every frame
 * rebuilds the whole buffer text, which is fine for source files and silly for
 * a megabyte of generated JSON.
 */
export const MAX_ANIMATABLE_CHARS = 400_000;

function clampPhase(ms: number, min: number, max: number): number {
  if (ms <= 0) return 0;
  return Math.min(max, Math.max(min, ms));
}

/** The text with every hunk applied, in document order. */
export function applyHunks(
  baseText: string,
  hunks: ReadonlyArray<{ at: number; oldText: string; newText: string }>,
): string {
  let out = '';
  let cursor = 0;
  for (const h of hunks) {
    out += baseText.slice(cursor, h.at);
    out += h.newText;
    cursor = h.at + h.oldText.length;
  }
  return out + baseText.slice(cursor);
}

/**
 * The single minimal replacement that turns `base` into `next`: the span between
 * the longest common prefix and the longest common suffix.
 *
 * This is the honest fallback for everything the hunk strings cannot express — a
 * pure insertion with no anchor, an `old_string` that does not occur (a tool
 * that normalised whitespace), a whole-file rewrite. It is also exactly what a
 * one-word change looks like, so the animation stays tight rather than deleting
 * and retyping fifteen identical lines of context.
 */
export function minimalReplacement(
  base: string,
  next: string,
): { at: number; oldText: string; newText: string } {
  const max = Math.min(base.length, next.length);
  let prefix = 0;
  while (prefix < max && base.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    base.charCodeAt(base.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    at: prefix,
    oldText: base.slice(prefix, base.length - suffix),
    newText: next.slice(prefix, next.length - suffix),
  };
}

/**
 * Locate every hunk in the base text and put them in DOCUMENT order — the order
 * the eye reads them in, which is the order the user asked them to play in.
 *
 * Search is cursor-advanced so two identical `old_string`s (the model changing
 * the same line twice) resolve to two different places rather than both to the
 * first. Returns `null` when any hunk cannot be placed or two of them overlap;
 * the caller then falls back to {@link minimalReplacement} against a known final
 * text, or to showing the diff. Guessing at a position would animate a delete in
 * the wrong part of the file, which is worse than not animating.
 */
export function locateHunks(
  baseText: string,
  inputs: readonly EditHunkInput[],
): Array<{ at: number; oldText: string; newText: string }> | null {
  const placed: Array<{ at: number; oldText: string; newText: string }> = [];
  let cursor = 0;
  for (const input of inputs) {
    const oldText = input.oldText ?? '';
    const newText = input.newText ?? '';
    if (oldText === '' && newText === '') continue;
    let at: number;
    if (oldText === '') {
      if (input.at === undefined || input.at < 0 || input.at > baseText.length) return null;
      at = input.at;
    } else {
      at = baseText.indexOf(oldText, cursor);
      if (at === -1) at = baseText.indexOf(oldText);
      if (at === -1) return null;
    }
    cursor = at + oldText.length;
    placed.push({ at, oldText, newText });
  }
  if (placed.length === 0) return null;
  placed.sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i += 1) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (prev === undefined || cur === undefined) return null;
    if (cur.at < prev.at + prev.oldText.length) return null; // overlapping hunks
  }
  return placed;
}

/** Give located hunks their slice of time, capped so the whole run stays short. */
function schedule(
  baseText: string,
  located: ReadonlyArray<{ at: number; oldText: string; newText: string }>,
  options: EditAnimationOptions,
): EditAnimationPlan {
  const o = { ...EDIT_ANIMATION_DEFAULTS, ...options };
  const finalText = applyHunks(baseText, located);

  const raw = located.map((h, i) => ({
    ...h,
    deleteMs: clampPhase((h.oldText.length / o.deleteCps) * 1000, o.minPhaseMs, o.maxPhaseMs),
    typeMs: clampPhase((h.newText.length / o.typeCps) * 1000, o.minPhaseMs, o.maxPhaseMs),
    beatMs: i === located.length - 1 ? 0 : o.beatMs,
  }));

  const uncapped = o.settleMs + raw.reduce((n, h) => n + h.deleteMs + h.typeMs + h.beatMs, 0);
  // Past the total budget every duration shrinks by the same factor, so the
  // motion keeps its shape (a long hunk still reads as the long one) and only
  // gets quicker. A zero stays zero — an empty phase must not become a pause.
  const k = uncapped > o.maxTotalMs ? o.maxTotalMs / uncapped : 1;
  const scale = (ms: number): number => (ms === 0 ? 0 : ms * k);

  const settleMs = scale(o.settleMs);
  let at = settleMs;
  const hunks: AnimatedHunk[] = raw.map((h) => {
    const deleteMs = scale(h.deleteMs);
    const typeMs = scale(h.typeMs);
    const beatMs = scale(h.beatMs);
    const startMs = at;
    at += deleteMs + typeMs + beatMs;
    return { at: h.at, oldText: h.oldText, newText: h.newText, startMs, deleteMs, typeMs, beatMs };
  });

  return {
    baseText,
    finalText,
    hunks,
    settleMs,
    totalMs: at,
    instant: baseText === finalText,
  };
}

/** A plan that is already over — the driver paints `finalText` and stops. */
function instantPlan(baseText: string, finalText: string): EditAnimationPlan {
  return { baseText, finalText, hunks: [], settleMs: 0, totalMs: 0, instant: true };
}

/**
 * Plan the delete-then-type motion for an edit.
 *
 * `finalText`, when the caller knows it (the file re-read from disk after the
 * tool ran), is both a safety net and a fallback: hunks that cannot be located
 * become the one minimal replacement between base and final, so the animation
 * still plays and still lands on the right bytes. Without it, an unlocatable
 * hunk returns `null` and the caller shows the diff instead.
 */
export function planEditAnimation(
  baseText: string,
  hunks: readonly EditHunkInput[],
  options: EditAnimationOptions = {},
  finalText?: string,
): EditAnimationPlan | null {
  const target = finalText;
  if (options.reducedMotion === true) {
    const located = locateHunks(baseText, hunks);
    return instantPlan(baseText, target ?? (located ? applyHunks(baseText, located) : baseText));
  }
  if (baseText.length > MAX_ANIMATABLE_CHARS) {
    const located = locateHunks(baseText, hunks);
    return instantPlan(baseText, target ?? (located ? applyHunks(baseText, located) : baseText));
  }

  const located = locateHunks(baseText, hunks);
  if (located !== null) {
    const plan = schedule(baseText, located, options);
    // A hunk set that lands somewhere other than the file the tool actually
    // produced is a mis-location — trust the disk, not the strings.
    if (target === undefined || plan.finalText === target) return plan;
  }
  if (target === undefined || target === baseText) return null;
  const fallback = minimalReplacement(baseText, target);
  if (fallback.oldText === '' && fallback.newText === '') return null;
  return schedule(baseText, [fallback], options);
}

/**
 * Plan the motion from one whole text to another — used when all the caller has
 * is "it looked like this, now it looks like that".
 */
export function planTextTransition(
  baseText: string,
  finalText: string,
  options: EditAnimationOptions = {},
): EditAnimationPlan | null {
  if (baseText === finalText) return null;
  if (options.reducedMotion === true || baseText.length > MAX_ANIMATABLE_CHARS) {
    return instantPlan(baseText, finalText);
  }
  const replacement = minimalReplacement(baseText, finalText);
  return schedule(baseText, [replacement], options);
}

/** The buffer text with hunks `[0, i)` applied, hunk `i` replaced by `mid`. */
function compose(
  plan: EditAnimationPlan,
  index: number,
  mid: string,
): { text: string; head: number } {
  let out = '';
  let cursor = 0;
  let head = 0;
  for (let j = 0; j < plan.hunks.length; j += 1) {
    const h = plan.hunks[j];
    if (h === undefined) continue;
    out += plan.baseText.slice(cursor, h.at);
    if (j === index) head = out.length;
    out += j < index ? h.newText : j === index ? mid : h.oldText;
    cursor = h.at + h.oldText.length;
  }
  return { text: out + plan.baseText.slice(cursor), head };
}

/**
 * Sample the plan: what the buffer holds at `elapsedMs`, and where the change is
 * happening.
 *
 * Progress inside a phase is LINEAR in time, not one character per frame. That
 * is what lets a capped phase finish on schedule — it simply moves more
 * characters per frame — and it is also what a token stream looks like, which is
 * the animation this one is matching.
 */
export function frameAt(plan: EditAnimationPlan, elapsedMs: number): EditFrame {
  if (plan.instant || plan.hunks.length === 0) {
    return { text: plan.finalText, caret: plan.finalText.length, phase: 'done', hunk: -1 };
  }
  const first = plan.hunks[0];
  if (first !== undefined && elapsedMs < first.startMs) {
    return { text: plan.baseText, caret: first.at, phase: 'settle', hunk: -1 };
  }
  if (elapsedMs >= plan.totalMs) {
    const last = plan.hunks[plan.hunks.length - 1];
    const composed = compose(plan, plan.hunks.length - 1, last?.newText ?? '');
    return {
      text: composed.text,
      caret: composed.head + (last?.newText.length ?? 0),
      phase: 'done',
      hunk: -1,
    };
  }

  for (let i = 0; i < plan.hunks.length; i += 1) {
    const h = plan.hunks[i];
    if (h === undefined) continue;
    const t = elapsedMs - h.startMs;
    if (t < 0) continue;
    const spanEnd = h.deleteMs + h.typeMs + h.beatMs;
    if (t >= spanEnd && i < plan.hunks.length - 1) continue;

    if (t < h.deleteMs) {
      // FORWARD DELETE: the caret stands still at the head of the span and the
      // text in front of it is eaten.
      const eaten = Math.min(h.oldText.length, Math.round((t / h.deleteMs) * h.oldText.length));
      const composed = compose(plan, i, h.oldText.slice(eaten));
      return { text: composed.text, caret: composed.head, phase: 'delete', hunk: i };
    }
    const typed = t - h.deleteMs;
    if (typed < h.typeMs) {
      // TYPE: growing from the very offset the delete finished at.
      const n = Math.min(h.newText.length, Math.round((typed / h.typeMs) * h.newText.length));
      const composed = compose(plan, i, h.newText.slice(0, n));
      return { text: composed.text, caret: composed.head + n, phase: 'type', hunk: i };
    }
    const composed = compose(plan, i, h.newText);
    return {
      text: composed.text,
      caret: composed.head + h.newText.length,
      phase: 'beat',
      hunk: i,
    };
  }

  return { text: plan.finalText, caret: plan.finalText.length, phase: 'done', hunk: -1 };
}

/** Where the first change happens — what a driver scrolls to before starting. */
export function firstEditOffset(plan: EditAnimationPlan): number {
  return plan.hunks[0]?.at ?? 0;
}
