/**
 * THE POP-OUT — the design language's `.bb-popout`: a card that opens beside the
 * control it explains, the first time the pointer rests on it, with a notch on
 * the side facing that control, a small demo above, a title, a line, and a small
 * "Got it".
 *
 * The user (2026-10-07): "pop out cards like rectangles rounded corners a little <
 * poking out wherever it's coming from on a hover maybe and then the top half
 * has the little animation with a bottom right button that says 'Got it'".
 *
 * Once per Mac and per feature: a tip that has been shown is remembered when it
 * closes, however it closes. It stays open while the pointer is on the control
 * or on the card, and closes a moment after it leaves both. Under `?piE2E`
 * nothing opens on hover; a probe asks with `window.__pi_tip(id)`.
 */

import { Glyph } from '@pi-desktop/ui';
import { type JSX, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ConnectorIcon } from '../connectors/ConnectorIcon';
import { useConnectorsStore } from '../state/connectors-store';
import { placeCard, type Side } from '../tour/tour-steps';
import { hasSeen, markSeenId } from './intro-store';

export type TipId = 'segment' | 'connectors';

interface Tip {
  readonly title: string;
  readonly text: string;
  /** The picture's one hue: the stage's wash. */
  readonly hue: 'teal' | 'sun' | 'pink';
  /** The side to open on when it has room. */
  readonly side?: Side;
  readonly demo: () => ReactNode;
}

const TIPS: Readonly<Record<TipId, Tip>> = {
  segment: {
    title: 'Segment',
    text: 'Split a model into its parts, then colour, move or export each one on its own.',
    hue: 'sun',
    demo: () => <SegmentDemo />,
  },
  connectors: {
    title: 'Connectors live in +',
    text: 'Turn one on or off for this chat. Bobble only knows about the ones that are on.',
    hue: 'teal',
    side: 'above',
    demo: () => <ConnectorsDemo />,
  },
};

interface TipState {
  readonly open: { id: TipId; anchor: HTMLElement } | null;
  readonly show: (id: TipId, anchor: HTMLElement) => void;
  readonly close: () => void;
}

export const useTipStore = create<TipState>((set, get) => ({
  open: null,
  show: (id, anchor) => set({ open: { id, anchor } }),
  close: () => {
    const open = get().open;
    if (open !== null) markSeenId(`tip:${open.id}`);
    set({ open: null });
  },
}));

const underTest = (): boolean =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E');

/** How long the pointer rests on the control before its tip opens. */
const DWELL_MS = 700;
/** How long the pointer may be off both the control and the card before it closes. */
const GRACE_MS = 350;

let leaveTimer: ReturnType<typeof setTimeout> | undefined;
const holdOpen = () => clearTimeout(leaveTimer);
const letGo = () => {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => useTipStore.getState().close(), GRACE_MS);
};

/** Attach a first-hover tip to the control `ref` points at. */
export function useFeatureTip(id: TipId, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null || underTest() || hasSeen(`tip:${id}`)) return;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const enter = () => {
      holdOpen();
      if (useTipStore.getState().open?.id === id) return;
      dwell = setTimeout(() => {
        if (!hasSeen(`tip:${id}`)) useTipStore.getState().show(id, el);
      }, DWELL_MS);
    };
    const leave = () => {
      clearTimeout(dwell);
      if (useTipStore.getState().open?.id === id) letGo();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      clearTimeout(dwell);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, [id, ref]);
}

/**
 * The same, for a control this app does not render itself (the composer's +
 * lives in @pi-desktop/ui): found by selector once it is on the page.
 */
export function useFeatureTipAt(id: TipId, selector: string): void {
  const ref = useRef<HTMLElement | null>(null);
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (underTest() || hasSeen(`tip:${id}`)) return;
    let raf = 0;
    let tries = 0;
    const look = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el !== null) {
        ref.current = el;
        setFound(true);
      } else if (tries++ < 120) raf = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(raf);
  }, [id, selector]);
  useFeatureTip(id, found ? ref : NONE);
}
const NONE: RefObject<HTMLElement | null> = { current: null };

if (underTest()) {
  (window as unknown as { __pi_tip?: (id: TipId, selector: string) => void }).__pi_tip = (
    id,
    selector,
  ) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el !== null) useTipStore.getState().show(id, el);
  };
}

const NOTCH: Record<Side, string> = {
  right: 'pd-tour-card--left',
  left: 'pd-tour-card--right',
  below: 'pd-tour-card--up',
  above: 'pd-tour-card--down',
};

/** The one tip on screen, drawn beside its control. Mount once (App). */
export function FeatureTipLayer(): JSX.Element | null {
  const open = useTipStore((s) => s.open);
  const close = useTipStore((s) => s.close);
  const [, tick] = useState(0);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onResize = () => tick((n) => n + 1);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  if (open === null || !open.anchor.isConnected) return null;
  const tip = TIPS[open.id];
  const r = open.anchor.getBoundingClientRect();
  const card = { width: 288, height: 268 };
  const place = placeCard(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    card,
    { width: window.innerWidth, height: window.innerHeight },
    12,
    12,
    tip.side,
  );
  return createPortal(
    <div
      role="dialog"
      aria-label={tip.title}
      data-testid={`tip-${open.id}`}
      data-hue={tip.hue}
      className={`pd-tour-card pd-tip ${NOTCH[place.side]}`}
      style={
        {
          left: place.x,
          top: place.y,
          '--notch': `${place.notch}px`,
          position: 'fixed',
          zIndex: 8500,
        } as React.CSSProperties
      }
      onPointerEnter={holdOpen}
      onPointerLeave={letGo}
    >
      <div className="pd-tip-stage" aria-hidden="true">
        {tip.demo()}
      </div>
      <p className="pd-tour-title pd-tip-title">{tip.title}</p>
      <p className="pd-tour-text">{tip.text}</p>
      <div className="pd-tip-foot">
        <button
          type="button"
          className="pd-tour-btn pd-focusable"
          data-testid="tip-ok"
          onClick={close}
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The Segment demo, ported from the language's SegmentTip card: the lamp model,
 * untinted, takes a hue per part — base teal, stem sun, shade pink — and the
 * stem and shade lift apart, the one place the three hues meet (a segmentation).
 */
function SegmentDemo(): JSX.Element {
  const part = (
    cls: string,
    hue: 'teal' | 'sun' | 'pink',
    body: string,
    cap?: { kind: 'top' | 'in'; cx: number; cy: number; rx: number; ry: number },
  ) => (
    <g className={`pd-segdemo-part ${cls}`} data-hue={hue}>
      <path className="pd-segdemo-n-body" d={body} />
      <path className="pd-segdemo-h-body" d={body} />
      <path className="pd-intro-light" d={body} />
      {cap === undefined ? null : (
        <>
          <ellipse
            className={`pd-segdemo-n-${cap.kind}`}
            cx={cap.cx}
            cy={cap.cy}
            rx={cap.rx}
            ry={cap.ry}
          />
          <ellipse
            className={`pd-segdemo-h-${cap.kind}`}
            cx={cap.cx}
            cy={cap.cy}
            rx={cap.rx}
            ry={cap.ry}
          />
        </>
      )}
    </g>
  );
  return (
    <svg className="pd-segdemo" viewBox="40 60 200 228" aria-hidden="true">
      <defs>
        <linearGradient id="pd-intro-round" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.42" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <ellipse className="pd-intro-ground" cx="140" cy="262" rx="78" ry="20" />
      {part('pd-segdemo-base', 'teal', 'M80 236V250A60 18 0 0 0 200 250V236Z', {
        kind: 'top',
        cx: 140,
        cy: 236,
        rx: 60,
        ry: 18,
      })}
      {part('pd-segdemo-stem', 'sun', 'M133 146V236A7 2.2 0 0 0 147 236V146Z')}
      {part('pd-segdemo-shade', 'pink', 'M110 102L78 164A62 18.6 0 0 0 202 164L170 102Z', {
        kind: 'in',
        cx: 140,
        cy: 102,
        rx: 30,
        ry: 9,
      })}
    </svg>
  );
}

/**
 * The Connectors demo, ported from the language's ConnectorsTip card: the +
 * menu's Connectors list in small — Browse connectors, then two connectors
 * with their official marks (from the catalog; the neutral glyph until it has
 * loaded) — and the first one's switch turning on.
 */
function ConnectorsDemo(): JSX.Element {
  const catalog = useConnectorsStore((s) => s.catalog);
  const mark = (id: string, name: string) =>
    catalog.find((c) => c.id === id) ?? { icon: '', iconSvg: undefined, name };
  return (
    <div className="pd-cdemo">
      <div className="pd-cdemo-row">
        <span className="pd-cdemo-mark pd-cdemo-mark--plain">
          <Glyph name="discover" size={14} />
        </span>
        <span className="pd-cdemo-name">Browse connectors</span>
      </div>
      <div className="pd-cdemo-row">
        <span className="pd-cdemo-mark">
          <ConnectorIcon connector={mark('google-calendar', 'Google Calendar')} size={14} />
        </span>
        <span className="pd-cdemo-name">Google Calendar</span>
        <span className="pd-cdemo-switch pd-cdemo-switch--flip">
          <i />
        </span>
      </div>
      <div className="pd-cdemo-row">
        <span className="pd-cdemo-mark">
          <ConnectorIcon connector={mark('gmail', 'Gmail')} size={14} />
        </span>
        <span className="pd-cdemo-name">Gmail</span>
        <span className="pd-cdemo-switch" data-on="true">
          <i />
        </span>
      </div>
    </div>
  );
}
