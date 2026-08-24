/**
 * ONE ROW THAT SCROLLS SIDEWAYS, with arrows at the edges.
 *
 * the user: "top reccomended needs to be 1 row no stacking and h scrollable", and
 * then a screenshot of how Unsloth does it — cards clipped at the boundary so
 * you can see there is more, and a round chevron floating over each end.
 *
 * WHY ARROWS RATHER THAN A SCROLLBAR. A horizontal scrollbar under five cards is
 * both ugly and, on a trackpad, redundant; but with NO affordance at all a row
 * that happens to fit the window looks identical to one hiding four more cards.
 * The arrows solve that by only existing when there is somewhere to go — which
 * means they are also the answer to "is there more?", not just the way to get
 * there.
 *
 * THE EDGE FADES RATHER THAN CUTS. A card sliced by a hard line reads as a
 * rendering fault; the same card fading out reads as "there is more". the user: "no
 * hard cutoff here." The fade is a mask on the scroller and it only applies to
 * the side that HAS more — fading the left edge at scroll zero would be a
 * promise of content that is not there.
 *
 * THE ARROWS FADE WITH THE POINTER. They are an affordance, not decoration, so
 * they appear when the pointer is over the row and go when it leaves — which
 * also keeps them off the cards while someone is reading them.
 */
import { IconChevronLeft, IconChevronRight } from '@pi-desktop/ui';
import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';

export interface CarouselProps {
  readonly children: ReactNode;
  readonly testid?: string;
}

export function Carousel({ children, testid = 'carousel' }: CarouselProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    /*
     * SLACK ON BOTH ENDS, and 1px was not enough. Fractional card widths mean
     * the exact end is rarely an integer, and `scroll-snap` settles against the
     * scroller's own padding rather than against zero — MEASURED, a row parked
     * at "the start" reported scrollLeft ~2 and grew a back arrow that went
     * nowhere. 4px covers both without hiding a real first step.
     */
    const SLACK = 4;
    setAtStart(el.scrollLeft <= SLACK);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - SLACK);
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const page = (dir: -1 | 1): void => {
    const el = ref.current;
    if (el === null) return;
    // Most of a screenful, not all of it: leaving a card visible across the jump
    // keeps the reader's place.
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  const arrow = (dir: -1 | 1, hidden: boolean): JSX.Element | null =>
    hidden ? null : (
      <button
        type="button"
        aria-label={dir === -1 ? 'Scroll left' : 'Scroll right'}
        data-testid={`${testid}-${dir === -1 ? 'prev' : 'next'}`}
        onClick={() => page(dir)}
        className={cx('pd-carousel-arrow pd-focusable', dir === -1 ? 'left-0' : 'right-0')}
      >
        {dir === -1 ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}
      </button>
    );

  return (
    /*
     * `isolation: isolate` (pd-carousel-wrap) rather than a z-index race. the user:
     * "the profile picture appears on top of the button but only when hovered."
     * A hovered card was winning the paint order against an absolutely
     * positioned sibling, which is the kind of bug that gets "fixed" by bidding
     * the z-index up until it stops. Isolating the wrapper makes the arrows and
     * the row members members of one stacking context, where the arrows' index
     * settles it once.
     */
    <div className="pd-carousel-wrap" data-testid={`${testid}-wrap`}>
      <div
        ref={ref}
        onScroll={measure}
        className="pd-carousel flex gap-3 overflow-x-auto"
        data-at-start={atStart}
        data-at-end={atEnd}
        data-testid={testid}
      >
        {children}
      </div>
      {arrow(-1, atStart)}
      {arrow(1, atEnd)}
    </div>
  );
}
