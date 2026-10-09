import { clsx } from 'clsx';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
} from 'react';

export interface EffortSliderProps {
  /** Number of discrete detents (e.g. 4 for low/medium/high/max). */
  steps: number;
  /** The current explicit detent index (0..steps-1) — drives aria + keyboard. */
  value: number;
  /** Visual fill fraction (0..1). In Auto this is the active tier's level; in
   * an explicit level it is that level's position. Kept separate from `value`
   * so the app maps Auto ↔ tier without the component knowing about tiers. */
  fill: number;
  /** Whether Auto is on. It is not a highlight any more — it REPLACES the
   * control: with Auto on there is no slider, because there is no level for the
   * user to be setting. Off, the slider comes back at `fill`/`value`. */
  auto: boolean;
  /** The header readout shown accent-lit at the top of the panel:
   * "Effort · Auto" (auto) or "Effort · High" (a pinned level). */
  label: string;
  /** Screen-reader value text (defaults to `label`). */
  valueText?: string;
  /** Text for the Auto toggle (default "Auto"). */
  autoLabel?: string;
  /** Fired with the detent index the user dragged/keyed to (flips to level). */
  onLevelChange: (index: number) => void;
  /** Fired when the Auto switch is flipped — in EITHER direction. It used to be
   * a one-way "return to Auto" reset, so the only way out of Auto was to drag a
   * slider that Auto was covering. */
  onToggleAuto: () => void;
  className?: string;
  'data-testid'?: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Map a 0..1 track fraction to the nearest detent index (0..steps-1). Pure so
 * the pointer-drag math is unit-testable without a DOM.
 */
export function pointerToIndex(fraction: number, steps: number): number {
  if (steps <= 1 || !Number.isFinite(fraction)) return 0;
  const idx = Math.round(clamp01(fraction) * (steps - 1));
  return Math.min(steps - 1, Math.max(0, idx));
}

/**
 * EffortSlider — the composer effort control (the user #6), restyled round-16 to the
 * Claude "thinking effort" look: a titled popover panel with the active readout
 * accent-lit up top beside a "?" help affordance, a horizontal track carrying a
 * dithered/textured heat fill (cool blue → hot near Max) and a clean white knob,
 * flanked by "Faster" / "Smarter" end labels, with a subtle "Auto" toggle below.
 *
 * Purely presentational + controlled: the app maps detents ↔ effort levels and
 * Auto ↔ the active model tier, passing the resolved `fill`/`label` in and taking
 * `onLevelChange`/`onToggleAuto` out — the value logic is unchanged by the restyle.
 *
 * With Auto ON the slider is not rendered at all: the switch is the control, and
 * the header readout is the answer. See the comment at the scale row.
 *
 * Accessible: the track is a `role="slider"` driven by arrows/Home/End as well
 * as pointer drag; the fill/knob transitions honor reduced-motion (CSS).
 */
export function EffortSlider({
  steps,
  value,
  fill,
  auto,
  label,
  valueText,
  autoLabel = 'Auto',
  onLevelChange,
  onToggleAuto,
  className,
  'data-testid': testId,
}: EffortSliderProps): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const max = Math.max(1, steps - 1);
  const frac = clamp01(fill);
  /*
   * The knob's CENTRE, as a fraction — CSS turns it into a position inside the
   * track's usable range (see `--pd-effort-knob-r`). The fill and the knob and
   * every dot are placed from this one number, which is why they cannot drift
   * apart: at Max the knob sits ON the last dot rather than half off the end,
   * which is what a percentage of the RAW width gives you.
   */
  const posVar = { ['--pd-effort-pos' as string]: frac } as CSSProperties;

  /* Which way the readout should slide. Remembering the previous fill (not
   * `value`, which stays put while Auto tracks a tier) means the word moves the
   * way the slider just moved: up for more effort, down for less. */
  const prevFill = useRef(fill);
  const dir = fill < prevFill.current ? 'down' : 'up';
  prevFill.current = fill;

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      onLevelChange(pointerToIndex(fraction, steps));
    },
    [onLevelChange, steps],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = Math.min(max, value + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = Math.max(0, value - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    onLevelChange(next);
  };

  return (
    <div
      className={clsx('pd-effort', className)}
      data-auto={auto ? '' : undefined}
      data-testid={testId}
    >
      {/* Header: the active readout (accent-lit) + a "?" help affordance. */}
      <div className="pd-effort-head">
        {/* Keyed by the label so React REMOUNTS it on every change — that is what
            replays the slide; a plain text swap would animate nothing. */}
        <span
          key={label}
          className="pd-effort-name"
          data-dir={dir}
          data-testid={testId !== undefined ? `${testId}-value` : undefined}
        >
          {label}
        </span>
        {/* A hover/pointer help affordance only — kept OUT of the tab order
            (tabIndex -1) so keyboard focus, and the popover's initial focus, land
            on the slider thumb below rather than this "?" button (the user #14: arrow
            keys were nudging the help button instead of the thumb). */}
        <button
          type="button"
          className="pd-effort-help"
          tabIndex={-1}
          aria-label="How effort works"
          title="Higher effort spends more time reasoning before answering. Adaptive matches the effort to each request."
        >
          ?
        </button>
      </div>

      {/*
        THE SLIDER ONLY EXISTS WHEN THERE IS A LEVEL TO SET.
        The user: "restyle auto to be a toggle button that just removes the slider
        while toggled on." It used to stay on screen in Auto, tracking the routed
        tier — a control that moved on its own and ignored you if you touched it,
        which is the worst of both: it looks settable and is not. With Auto on the
        readout above says what the router chose, and that is the whole truth.
      */}
      {auto ? null : (
        <div className="pd-effort-scale">
          <span className="pd-effort-flank" aria-hidden="true">
            Faster
          </span>
          <div
            ref={trackRef}
            className="pd-effort-track"
            role="slider"
            tabIndex={0}
            aria-label="Effort level"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={valueText ?? label}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div
              className="pd-effort-fill"
              style={{ ...posVar, ['--pd-effort-heat' as string]: frac } as CSSProperties}
            />
            {/*
              THE DETENTS, DRAWN — after the fill, deliberately. Both are absolutely
              positioned siblings, so the later one wins: parked before the fill
              they were painted over by it, and every dot behind the knob simply
              vanished. The user: "dots for levels aswell." Without them the
              track says only "somewhere between faster and smarter" — you cannot
              see that there are four settings, which one you are on, or how far
              the next one is. They are also where the knob lands, so they double
              as the proof that the geometry is honest.
            */}
            <span className="pd-effort-dots" aria-hidden="true">
              {Array.from({ length: steps }, (_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the detent.
                  key={i}
                  className="pd-effort-dot"
                  data-on={i / max <= frac + 0.001 ? '' : undefined}
                  style={{ ['--pd-effort-dot' as string]: i / max } as CSSProperties}
                />
              ))}
            </span>
            {/* The knob is the TRACK's child, not the fill's: parented to the fill
                it inherited the fill's width animation and arrived a beat late,
                which is the difference between a knob that slides and one that
                catches up. */}
            <span className="pd-effort-knob" style={posVar} aria-hidden="true" />
          </div>
          <span className="pd-effort-flank" aria-hidden="true">
            Smarter
          </span>
        </div>
      )}

      {/*
        A SWITCH, not a pill that lights up. It is the only control on the panel
        when Auto is on, and it has to say both what it does and which way it is
        — `role="switch"` so a screen reader gets the same, and it flips BOTH
        ways so Auto is escapable without a slider to drag.
      */}
      <div className="pd-effort-foot">
        <button
          type="button"
          className="pd-effort-auto"
          role="switch"
          aria-checked={auto}
          data-active={auto ? '' : undefined}
          onClick={onToggleAuto}
          data-testid={testId !== undefined ? `${testId}-auto` : undefined}
        >
          <span className="pd-effort-auto-label">{autoLabel}</span>
          <span className="pd-effort-auto-switch" aria-hidden="true">
            <span className="pd-effort-auto-knob" />
          </span>
        </button>
      </div>
    </div>
  );
}
