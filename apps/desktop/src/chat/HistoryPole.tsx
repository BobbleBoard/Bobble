/**
 * The history pole: hover the right edge of a long conversation and a thin line
 * appears with a few marked places on it. Click anywhere on it to travel there.
 *
 * The user's description, which is also the spec: "a vertical line, around the
 * thickness of a scrollbar, little thinner, that has circles on it … these
 * circles should be just like holes on the line of a graph looking, and bulge a
 * bit on hover … clicking takes them there (smooth scroll quickly to the point
 * ease in out tween) … ensure it just appears on hover on that area (smoothly)
 * and only when useful."
 *
 * WHY IT IS NOT A SCROLLBAR. The scrollbar answers "how far through am I"; this
 * answers "where was the thing I asked about". They look alike and are not the
 * same tool — which is why the dots are user TURNS and the hover shows the
 * words, not a thumbnail.
 *
 * Everything about which dots and whether at all lives in history-pole.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  easeInOutCubic,
  type PoleDot,
  type PoleTurn,
  poleDots,
  scrollTargetFor,
} from './history-pole';

/** How long the travel takes. Long enough to see where you went, short enough
 * not to wait for it — a jump that animates for a second reads as lag. */
const TRAVEL_MS = 420;
/** A dot leaves this much air above the message it lands on. */
const LANDING_PAD = 24;

/** Animate `el.scrollTop` to `to`, easing at both ends. Returns a canceller. */
function travel(el: HTMLElement, to: number, reduced: boolean): () => void {
  const from = el.scrollTop;
  if (reduced || Math.abs(to - from) < 2) {
    el.scrollTop = to;
    return () => undefined;
  }
  const started = performance.now();
  let raf = 0;
  let cancelled = false;
  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - started) / TRAVEL_MS);
    el.scrollTop = from + (to - from) * easeInOutCubic(t);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}

export function HistoryPole({
  scrollRef,
  /** Bumped by the thread whenever its content changes, so the pole re-measures. */
  revision,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  revision: number;
}) {
  const [dots, setDots] = useState<PoleDot[]>([]);
  const [hovering, setHovering] = useState(false);
  /** Where the visible screen sits on the pole, as {top, height} fractions. */
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  const [hoveredDot, setHoveredDot] = useState<string | null>(null);
  const cancelTravel = useRef<() => void>(() => undefined);

  /*
   * MEASURE FROM THE DOM, NOT FROM THE MESSAGE LIST. Where a turn sits on the
   * page is a fact about layout — images that have not loaded, a chain that is
   * open, a code block that wrapped — and none of that is knowable from the
   * store. `data-user-turn` is the thread's own marker for its landmarks.
   */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const turns: PoleTurn[] = [...el.querySelectorAll<HTMLElement>('[data-user-turn]')].map(
      (node) => ({
        id: node.dataset.userTurn ?? '',
        offsetTop: node.offsetTop,
        text: node.textContent ?? '',
      }),
    );
    setDots(poleDots({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }, turns));
  }, [scrollRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a re-measure trigger, not a value the effect reads
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (el === null) return;
    /*
     * BOTH BOXES. The scroller tells us when the WINDOW changed size; its
     * content tells us when the THREAD did — an answer finishing, a chain
     * opening, an image loading. Watching only the scroller left the dots
     * pointing at where the turns used to be, because a scroller's own box does
     * not change when what is inside it grows.
     */
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    if (el.firstElementChild !== null) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure, scrollRef, revision]);

  // Where the reader is, so the pole's filled length says it without a second
  // control. Passive: this must never be the thing that makes scrolling janky.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-attaches the listener after the thread changes shape
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = () => {
      /*
       * A WINDOW, NOT A PROGRESS BAR.
       *
       * The first cut filled the line from the top down to where you were, which
       * is accurate and, at the bottom of a long thread, paints the entire pole
       * a solid colour — at which point it reads as a scrollbar and the dots are
       * decoration on it. Showing the SCREEN instead says the same "where am I"
       * and also says how little of this thread one screen is, which is the
       * reason the pole exists at all.
       */
      const height = Math.min(1, el.clientHeight / Math.max(1, el.scrollHeight));
      const span = Math.max(1, el.scrollHeight - el.clientHeight);
      const top = Math.min(1 - height, Math.max(0, el.scrollTop / span) * (1 - height));
      setViewport({ top, height });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, revision]);

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  const goTo = (top: number) => {
    const el = scrollRef.current;
    if (el === null) return;
    cancelTravel.current();
    cancelTravel.current = travel(el, top, reduced);
  };

  useEffect(() => () => cancelTravel.current(), []);

  if (dots.length === 0) return null;

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (el === null) return;
    const box = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientY - box.top) / Math.max(1, box.height);
    goTo(
      scrollTargetFor({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }, fraction),
    );
  };

  return (
    /* The hover ZONE is wider than the pole so the line does not have to be
       hit before it exists — an affordance you can only reach once it appears
       is one you never find. */
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer affordance over the scroller; every destination is also reachable by scrolling
    <div
      className="pd-pole-zone"
      data-testid="history-pole-zone"
      data-open={hovering ? 'true' : 'false'}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setHoveredDot(null);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the dots inside are real buttons and the thread scrolls with the keyboard */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — there is no keyboard concept of "a fraction of the way down a line", and every dot is focusable */}
      <div className="pd-pole" data-testid="history-pole" onClick={onTrackClick}>
        <span className="pd-pole-line" aria-hidden="true" />
        <span
          className="pd-pole-line pd-pole-line--here"
          aria-hidden="true"
          data-testid="history-pole-viewport"
          style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%` }}
        />
        {dots.map((dot) => (
          <button
            key={dot.id}
            type="button"
            className="pd-pole-dot"
            data-testid="history-pole-dot"
            style={{ top: `${dot.fraction * 100}%` }}
            aria-label={`Jump to message ${dot.ordinal} of ${dot.total}: ${dot.label}`}
            onMouseEnter={() => setHoveredDot(dot.id)}
            onMouseLeave={() => setHoveredDot(null)}
            onFocus={() => setHoveredDot(dot.id)}
            onBlur={() => setHoveredDot(null)}
            onClick={(e) => {
              e.stopPropagation();
              goTo(Math.max(0, dot.offsetTop - LANDING_PAD));
            }}
          >
            {hoveredDot === dot.id ? (
              <span className="pd-pole-preview" data-testid="history-pole-preview">
                <span className="pd-pole-preview-meta">
                  Message {dot.ordinal} of {dot.total}
                </span>
                <span className="pd-pole-preview-text">{dot.label}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
