/**
 * THE INTRO CARD, ON SCREEN — the design language's `.bb-intro` on its scrim:
 * a frosted card, the feature's demo on a stage washed in the picture's hue, an
 * eyebrow naming the feature, a title in the display face, one sentence of what
 * it does for you, and "Got it" bottom right. Esc, Got it, or a click on the
 * scrim dismisses it for good. With Reduce Motion the demo shows its rest state.
 */
import { agentCursorSvg } from '@pi-desktop/shared';
import { type JSX, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from '../state/app-nav-store';
import { type IntroId, useIntroStore } from './intro-store';

interface Intro {
  readonly eyebrow: string;
  readonly title: string;
  readonly text: string;
  readonly hue: 'teal' | 'sun' | 'pink';
  readonly demo: () => ReactNode;
  /** A quiet second button, bottom left: where to go to do something about it. */
  readonly action?: { readonly label: string; readonly link: string };
}

const INTROS: Readonly<Record<IntroId, Intro>> = {
  studio3d: {
    eyebrow: '3D Studio',
    title: 'A picture becomes a model',
    text: 'Drop in a picture or describe what you want. Bobble builds the model here on this Mac, and you can texture and animate it after.',
    hue: 'sun',
    demo: () => <PictureToModel />,
  },
  computerUse: {
    eyebrow: 'Computer use',
    title: 'Bobble can use your apps',
    text: 'It works in the background with its own cursor, so yours stays free. You choose which apps it can open.',
    hue: 'teal',
    demo: () => <CursorAtWork />,
    action: { label: 'Choose apps', link: 'settings:computer-use' },
  },
};

export function IntroCard(): JSX.Element | null {
  const open = useIntroStore((s) => s.open);
  const dismiss = useIntroStore((s) => s.dismiss);
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open === null) return;
    okRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, dismiss]);

  if (open === null) return null;
  const intro = INTROS[open];
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim's click is a convenience; Esc and Got it are the controls
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the window
    <div
      className="pd-intro-scrim"
      data-testid="intro-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        className="pd-intro"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-intro-title"
        data-testid={`intro-${open}`}
        data-hue={intro.hue}
      >
        <div className="pd-intro-stage" aria-hidden="true">
          {intro.demo()}
        </div>
        <div className="pd-intro-body">
          <p className="pd-intro-eyebrow">{intro.eyebrow}</p>
          <h2 id="pd-intro-title" className="pd-display-s">
            {intro.title}
          </h2>
          <p className="pd-intro-text">{intro.text}</p>
        </div>
        <div className="pd-intro-foot">
          {intro.action === undefined ? null : (
            <button
              type="button"
              className="pd-tour-btn pd-tour-btn--quiet pd-intro-action pd-focusable"
              data-testid="intro-action"
              onClick={() => {
                const link = intro.action?.link;
                dismiss();
                if (link !== undefined) navigate(link);
              }}
            >
              {intro.action.label}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className="pd-tour-btn pd-focusable"
            data-testid="intro-ok"
            onClick={dismiss}
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The 3D demo, ported from the language's Intro3D card: a flat lamp in the hue
 * on a white plate, three dots thinking, and the same lamp as a model, building
 * from the ground up, part by part, lit from the upper left.
 */
function PictureToModel(): JSX.Element {
  return (
    <svg className="pd-intro-make" viewBox="0 0 424 236" aria-hidden="true">
      <defs>
        <linearGradient id="pd-intro-round" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.42" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <rect className="pd-intro-plate" x="44" y="50" width="136" height="136" rx="14" />
      <path className="pd-intro-flat" d="M96 82h32l16 40H80z" />
      <rect className="pd-intro-flat-ink" x="109" y="122" width="6" height="32" rx="2" />
      <rect className="pd-intro-flat" x="86" y="152" width="52" height="12" rx="6" />
      <circle className="pd-intro-dot" cx="200" cy="118" r="3.5" />
      <circle className="pd-intro-dot pd-intro-d2" cx="212" cy="118" r="3.5" />
      <circle className="pd-intro-dot pd-intro-d3" cx="224" cy="118" r="3.5" />
      <svg
        className="pd-intro-model"
        x="240"
        y="24"
        width="168"
        height="190"
        viewBox="56 84 168 190"
        aria-hidden="true"
      >
        <ellipse className="pd-intro-ground" cx="140" cy="262" rx="78" ry="20" />
        <g className="pd-intro-part pd-intro-base">
          <path className="pd-intro-body-fill" d="M80 236V250A60 18 0 0 0 200 250V236Z" />
          <path className="pd-intro-light" d="M80 236V250A60 18 0 0 0 200 250V236Z" />
          <ellipse className="pd-intro-top" cx="140" cy="236" rx="60" ry="18" />
        </g>
        <g className="pd-intro-part pd-intro-stem">
          <path className="pd-intro-body-fill" d="M133 146V236A7 2.2 0 0 0 147 236V146Z" />
          <path className="pd-intro-light" d="M133 146V236A7 2.2 0 0 0 147 236V146Z" />
        </g>
        <g className="pd-intro-part pd-intro-shade">
          <path className="pd-intro-body-fill" d="M110 102L78 164A62 18.6 0 0 0 202 164L170 102Z" />
          <path className="pd-intro-light" d="M110 102L78 164A62 18.6 0 0 0 202 164L170 102Z" />
          <ellipse className="pd-intro-in" cx="140" cy="102" rx="30" ry="9" />
        </g>
      </svg>
    </svg>
  );
}

/**
 * The computer-use demo, ported from the language's ComputerUse card: a small
 * window, and Bobble's cursor — the shipping drawing from agent-cursor.ts,
 * copied, never redrawn — glides to the field, types (its pill says "Typing",
 * never what), then presses the button, which turns into a check.
 */
function CursorAtWork(): JSX.Element {
  const cursorRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (cursorRef.current !== null) cursorRef.current.innerHTML = agentCursorSvg();
  }, []);
  return (
    <div className="pd-cu-mini">
      <div className="pd-cu-window">
        <div className="pd-cu-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="pd-cu-body">
          <h3 className="pd-display-s pd-cu-title">Book a table</h3>
          <p className="pd-cu-label" />
          <div className="pd-cu-field pd-cu-focus">
            <span className="pd-cu-typed">
              <i className="pd-cu-line" />
              <i className="pd-cu-caret" />
            </span>
          </div>
          <p className="pd-cu-label" style={{ width: 44 }} />
          <div className="pd-cu-field" />
          <div className="pd-cu-btn">
            <i />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M5 14L8.5 17.5L19 6.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="pd-cu-cursor">
            <span ref={cursorRef} />
            <span className="pd-cu-status pd-cu-s-type">Typing</span>
            <span className="pd-cu-status pd-cu-s-click">Clicking</span>
          </span>
        </div>
      </div>
    </div>
  );
}
