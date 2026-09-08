/**
 * The DRIVER for the delete-then-type edit motion — the ten lines of clock and
 * the five of "should this play at all". The motion itself lives in
 * {@link ./edit-animation.ts}, which is pure; this samples it.
 *
 * It deliberately produces nothing but TEXT and a CARET. The text goes into the
 * same surface a file being written goes into, and reaches CodeMirror through
 * the same `streamingUpdateSpec` minimal-change reconcile — so an edit and a
 * write are one animation system with two callers, not two systems.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';
import {
  type EditAnimationPlan,
  type EditFrame,
  firstEditOffset,
  frameAt,
} from './edit-animation.ts';

/** An edit motion a surface has been handed, with the clock it started on. */
export interface EditAnimationSpec {
  /**
   * Identity of this motion — the edit's tool-call id. A new id is a new
   * motion; the same id re-rendered is the same motion, continuing.
   */
  id: string;
  /** The schedule, from `planEditAnimation`. */
  plan: EditAnimationPlan;
  /**
   * `Date.now()` when the motion began, set ONCE by the app.
   *
   * This is what makes the animation idempotent across a remount: a tab
   * switched away from mid-edit and come back to has an elapsed time past the
   * end of the plan, so it settles on the final text instead of replaying a
   * motion the user already missed.
   */
  startedAt: number;
}

/** What the surface should draw right now, or `null` when there is no motion. */
export interface EditAnimationState extends EditFrame {
  /** Still moving — the surface must not accept edits or stick to the bottom. */
  playing: boolean;
  /** The motion was skipped and this is the final state, arrived at directly. */
  skipped: boolean;
}

/** A probe the text surface fills in so the driver can ask "would they see it?" */
export type OffscreenProbe = { current: ((pos: number) => boolean) | null };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface EditAnimationDeps {
  /** The surface's outer box — a zero-height box is a collapsed/hidden panel. */
  hostRef: RefObject<HTMLElement | null>;
  /** Filled by the text surface; `null` while no view is mounted. */
  offscreenProbe?: OffscreenProbe;
  /** Set once the reader has scrolled this surface by hand. */
  userScrolledRef?: RefObject<boolean>;
}

/**
 * Play `spec`, or decide not to and hand back its ending.
 *
 * NOT PLAYED, SETTLED — the four ways the motion is a bad idea, each landing on
 * the final text with no movement at all:
 *   - `prefers-reduced-motion`;
 *   - the window is in the background (`document.hidden`) — and `rAF` itself
 *     stops there, so a motion that starts and then loses the window resumes by
 *     jumping to wherever the clock got to, never mid-delete;
 *   - the surface is not laid out (a collapsed canvas, a tab that is not the
 *     active one — its surface is not even mounted);
 *   - the reader has scrolled this file by hand AND the edit is off screen. An
 *     edit somewhere they are not looking is worth bringing into view; an edit
 *     somewhere they have deliberately scrolled away from is not worth yanking
 *     them back to. The same free-scroll courtesy the write path already keeps.
 */
export function useEditAnimation(
  spec: EditAnimationSpec | undefined,
  deps: EditAnimationDeps,
): EditAnimationState | null {
  const [frame, setFrame] = useState<EditAnimationState | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const id = spec?.id;
  const startedAt = spec?.startedAt;

  // Re-runs only on a NEW motion (id/clock), never on an unrelated re-render —
  // restarting the loop mid-delete would stutter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the motion.
  useEffect(() => {
    const current = specRef.current;
    if (current === undefined) {
      setFrame(null);
      return;
    }
    const { plan, startedAt: began } = current;
    const settle = (): void => {
      setFrame({
        text: plan.finalText,
        caret: plan.finalText.length,
        phase: 'done',
        hunk: -1,
        playing: false,
        skipped: true,
      });
    };

    if (plan.instant || plan.hunks.length === 0) return settle();
    if (prefersReducedMotion()) return settle();
    if (typeof document !== 'undefined' && document.hidden) return settle();
    const host = depsRef.current.hostRef.current;
    if (host !== null && host.getBoundingClientRect().height < 8) return settle();
    if (Date.now() - began >= plan.totalMs) return settle();
    const offscreen = depsRef.current.offscreenProbe?.current?.(firstEditOffset(plan));
    if (depsRef.current.userScrolledRef?.current === true && offscreen === true) return settle();

    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const f = frameAt(plan, Date.now() - began);
      const done = f.phase === 'done';
      setFrame({ ...f, playing: !done, skipped: false });
      if (done) return;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [id, startedAt]);

  return spec === undefined ? null : frame;
}
