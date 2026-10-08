/**
 * THE QUICK TOUR, ON SCREEN: a spotlight on one control at a time and the design
 * language's pop-out beside it — the notch pointing at the control, a title, a
 * line, the step count, Back, and Next (Got it on the last).
 *
 * The steps are the screen's (tour-steps.ts), resolved against the page when the
 * tour opens; a control that is not on screen is skipped. The spotlight and the
 * card follow their target every frame, so a sidebar that slides or a window
 * that resizes does not leave them pointing at the old place. Esc closes it,
 * the arrow keys step through it, and with Reduce Motion nothing glides.
 */
import { IconClose } from '@pi-desktop/ui';
import { type JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Box, placeCard, resolveSteps, type Side, TOUR_STEPS } from './tour-steps';
import { useTourStore } from './tour-store';

const PAD = 6;

function boxOf(selector: string): Box | null {
  const el = document.querySelector(selector);
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function GuidedTour(): JSX.Element | null {
  const screen = useTourStore((s) => s.screen);
  const close = useTourStore((s) => s.close);
  if (screen === null) return null;
  // To the body: the sidebar slides with a transform, and a fixed overlay inside
  // a transformed ancestor is positioned against that ancestor, not the window.
  return createPortal(<Tour key={screen} screen={screen} onClose={close} />, document.body);
}

function Tour({
  screen,
  onClose,
}: {
  screen: NonNullable<ReturnType<typeof useTourStore.getState>['screen']>;
  onClose: () => void;
}): JSX.Element | null {
  // Resolved once, when the tour opens: what is on screen now is the tour.
  const steps = useMemo(() => resolveSteps(TOUR_STEPS[screen], boxOf, viewport()), [screen]);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: 300, height: 160 });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const current = steps[index];
  const last = index === steps.length - 1;

  // Follow the target every frame: sidebars slide, windows resize, lists scroll.
  useEffect(() => {
    if (current === undefined) return;
    let raf = 0;
    const tick = () => {
      const raw = boxOf(current.selector);
      const [t, r, bt, l] = current.step.inset ?? [0, 0, 0, 0];
      const b =
        raw === null
          ? null
          : { x: raw.x + l, y: raw.y + t, width: raw.width - l - r, height: raw.height - t - bt };
      setTarget((prev) =>
        prev !== null &&
        b !== null &&
        Math.abs(prev.x - b.x) < 0.5 &&
        Math.abs(prev.y - b.y) < 0.5 &&
        Math.abs(prev.width - b.width) < 0.5 &&
        Math.abs(prev.height - b.height) < 0.5
          ? prev
          : b,
      );
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [current]);

  // The card's own size decides where it fits.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - cardSize.width) > 0.5 || Math.abs(r.height - cardSize.height) > 0.5) {
      setCardSize({ width: r.width, height: r.height });
    }
  });

  // Focus moves to the card's main button, and Esc / arrows drive it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on each step
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, steps.length - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, steps.length]);

  if (current === undefined) {
    // Nothing on this screen to point at: there is no tour to give.
    queueMicrotask(onClose);
    return null;
  }

  // Padded around the control, and kept inside the window: a sidebar row
  // starts at the window's left edge, and its ring was cut off there.
  const spot = (() => {
    if (target === null) return null;
    const v = viewport();
    const x = Math.max(2, target.x - PAD);
    const y = Math.max(2, target.y - PAD);
    const right = Math.min(v.width - 2, target.x + target.width + PAD);
    const bottom = Math.min(v.height - 2, target.y + target.height + PAD);
    return { x, y, width: right - x, height: bottom - y };
  })();
  const place = spot === null ? null : placeCard(spot, cardSize, viewport());
  const notchClass: Record<Side, string> = {
    right: 'pd-tour-card--left',
    left: 'pd-tour-card--right',
    below: 'pd-tour-card--up',
    above: 'pd-tour-card--down',
  };

  return (
    <div className="pd-tour" data-testid="tour" data-screen={screen}>
      {/* The page under the scrim is not for clicking while the tour is open. */}
      <div className="pd-tour-shield" aria-hidden="true" />
      {spot !== null ? (
        <div
          className="pd-tour-spot"
          data-testid="tour-spot"
          style={{ left: spot.x, top: spot.y, width: spot.width, height: spot.height }}
          aria-hidden="true"
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-tour-title"
        aria-describedby="pd-tour-body"
        data-testid="tour-card"
        data-step={current.step.id}
        data-side={place?.side}
        className={`pd-tour-card ${place === null ? '' : notchClass[place.side]}`}
        style={
          {
            left: place?.x ?? -9999,
            top: place?.y ?? -9999,
            '--notch': `${place?.notch ?? 28}px`,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          className="pd-tour-close pd-focusable"
          aria-label="End the tour"
          data-testid="tour-close"
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
        <h2 id="pd-tour-title" className="pd-tour-title">
          {current.step.title}
        </h2>
        <p id="pd-tour-body" className="pd-tour-text">
          {current.step.body}
        </p>
        <div className="pd-tour-foot">
          <span className="pd-tour-count" data-testid="tour-count">
            {index + 1} of {steps.length}
          </span>
          {index > 0 ? (
            <button
              type="button"
              className="pd-tour-btn pd-tour-btn--quiet pd-focusable"
              data-testid="tour-back"
              onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            >
              Back
            </button>
          ) : null}
          <button
            ref={nextRef}
            type="button"
            className="pd-tour-btn pd-focusable"
            data-testid={last ? 'tour-done' : 'tour-next'}
            onClick={() => (last ? onClose() : setIndex((i) => i + 1))}
          >
            {last ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
