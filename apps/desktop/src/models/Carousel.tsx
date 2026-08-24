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
 * THE CLIP IS PART OF THE MESSAGE. A card cut by the right edge says "more" more
 * clearly than any control, which is why the row is not padded to end on a card
 * boundary.
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
    setAtStart(el.scrollLeft <= 1);
    // 1px of slack: fractional widths mean the exact end is rarely an integer,
    // and an arrow that never quite disappears looks broken.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
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
    <div className="relative" data-testid={`${testid}-wrap`}>
      <div
        ref={ref}
        onScroll={measure}
        className="pd-carousel pd-scroll--hidden flex gap-3 overflow-x-auto"
        data-testid={testid}
      >
        {children}
      </div>
      {arrow(-1, atStart)}
      {arrow(1, atEnd)}
    </div>
  );
}
