/**
 * THE FRAME EVERY STUDIO SHARES.
 *
 * Three studios that each invented their own header, their own prompt box and
 * their own results strip would drift within a week — and they are the same
 * program three times: describe a thing, set a few knobs, press the button,
 * wait, look at what came out, keep or discard it, and go again. Only the knobs
 * differ. So the shell owns everything identical and each studio supplies only
 * its own controls and its own result renderer.
 *
 * WHY THE COMPOSER IS DOCKED AT THE BOTTOM.
 *
 * It was at the top, and the argument for that was: a studio is not a
 * conversation, you are iterating on ONE description, so the description must
 * stay put under your hands while the output changes below it.
 *
 * The premise was right and the conclusion did not follow. Docking the composer
 * to the BOTTOM of the window keeps it just as still — it is outside the scroll
 * container, so it never moves as results grow — while handing the room's whole
 * remaining height to the thing you came here to look at. the user, on the shipped
 * build: "a lot of blank empty space and really oddly the input bar and all is
 * at the top". Both halves of that were one bug: the composer, its four knobs
 * and its button occupied the top 21% of the window, and the 79% below it was
 * empty because the results had been pushed out of the place your eye lands.
 */
import { Button, IconChevronLeft, ScrollArea, Spinner } from '@pi-desktop/ui';
import { type JSX, type ReactNode, useEffect } from 'react';
import { exitModality } from '../state/modality-store';

export interface StudioShellProps {
  readonly title: string;
  /** The studio's own controls, in the composer beside the run button. */
  readonly controls: ReactNode;
  /**
   * Sits in the HEADER, not above the prompt — the audio mode switch is the
   * room's identity while you are in it, so it belongs where the room is named
   * rather than as a third thing stacked on top of the composer.
   */
  readonly headerAccessory?: ReactNode;
  readonly prompt: string;
  readonly onPrompt: (v: string) => void;
  readonly placeholder: string;
  /** Multi-line for speech (you paste a paragraph), single for a description. */
  readonly multiline?: boolean;
  readonly onRun: () => void;
  readonly busy: boolean;
  readonly runLabel: string;
  /** Blocks the run button with a reason, when the studio cannot run at all. */
  readonly blocked?: string;
  readonly error?: string | null;
  readonly children: ReactNode;
  readonly testid?: string;
}

export function StudioShell({
  title,
  controls,
  headerAccessory,
  prompt,
  onPrompt,
  placeholder,
  multiline = false,
  onRun,
  busy,
  runLabel,
  blocked,
  error,
  children,
  testid = 'studio',
}: StudioShellProps): JSX.Element {
  const canRun = !busy && blocked === undefined && prompt.trim().length > 0;

  /*
   * ESCAPE LEAVES THE ROOM. It is a full-window takeover with one way out — a
   * pill you have to travel to the top-left corner to press — and every other
   * takeover on macOS answers Escape. Ignored while a menu or dialog is up, so
   * this never steals a dismissal that belongs to something in front of it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
      exitModality();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="pd-studio" data-testid={testid}>
      <header className="pd-studio-head">
        {/* The traffic-light inset, same as every other full-window takeover. */}
        <div className="pd-studio-head-drag" />
        <button
          type="button"
          className="pd-studio-back pd-focusable"
          data-testid="studio-back"
          onClick={exitModality}
        >
          <IconChevronLeft size={15} />
          Chat
        </button>
        <h1 className="pd-studio-title">{title}</h1>
        {headerAccessory !== undefined ? (
          <div className="pd-studio-head-accessory">{headerAccessory}</div>
        ) : null}
      </header>

      {/* THE ROOM'S SUBJECT. Everything the studio made, and the only thing that
          scrolls — it gets all the height the composer is not using. */}
      <ScrollArea className="pd-studio-canvas">
        <div className="pd-studio-results" data-testid="studio-results">
          {children}
        </div>
      </ScrollArea>

      <div className="pd-studio-compose">
        <div className="pd-studio-composer">
          <div className="pd-studio-prompt-row">
            {multiline ? (
              <textarea
                className="pd-studio-prompt pd-studio-prompt--multi pd-focusable"
                data-testid="studio-prompt"
                value={prompt}
                placeholder={placeholder}
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => {
                  /*
                   * ⌘↩ RUNS. The single-line branch has always run on Enter; the
                   * textarea had no key handling at all, so Speech — the default
                   * mode of the Audio Studio — could only be run by travelling
                   * the width of the window to the button. Plain Enter still
                   * inserts a newline, because here you are typing a paragraph.
                   */
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) {
                    e.preventDefault();
                    onRun();
                  }
                }}
                rows={3}
              />
            ) : (
              <input
                className="pd-studio-prompt pd-focusable"
                data-testid="studio-prompt"
                value={prompt}
                placeholder={placeholder}
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Enter runs, because a one-line description is a thing you
                  // finish typing — not a field you tab out of.
                  if (e.key === 'Enter' && canRun) onRun();
                }}
              />
            )}
          </div>

          <div className="pd-studio-controls">
            {controls}
            <div className="flex-1" />
            {/*
              ACCENT, NOT PRIMARY. `.pd-btn--primary` is `background:
              var(--pd-text-primary)` — a WHITE block on the dark themes — so a
              DISABLED run button was still the brightest object on the screen.
              The disabled state is neutralised in CSS rather than dimmed: a
              half-opacity accent fill on a light background reads as a live blue
              button with unreadable text, not as an inert one.
            */}
            <Button
              variant="accent"
              className="pd-studio-run"
              data-testid="studio-run"
              disabled={!canRun}
              title={blocked}
              onClick={onRun}
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <Spinner size={13} /> Working…
                </span>
              ) : (
                runLabel
              )}
            </Button>
          </div>

          {blocked !== undefined ? (
            <p className="pd-studio-blocked" data-testid="studio-blocked">
              {blocked}
            </p>
          ) : null}
          {error !== null && error !== undefined && error !== '' ? (
            <p className="pd-studio-error" data-testid="studio-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A labelled knob. Keeps every control in every studio the same shape. */
export function Knob({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="pd-studio-knob">
      <span className="pd-studio-knob-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * A segmented choice — the control that replaced most of the number spinners.
 *
 * A person choosing how long a clip runs is not thinking "37 seconds"; they are
 * thinking short, or long. Discrete named choices also let each option carry
 * what it COSTS, which a spinner cannot.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  testid,
}: {
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  testid?: string;
}): JSX.Element {
  return (
    <div className="pd-seg pd-seg--inline" role="radiogroup" data-testid={testid}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="pd-seg-item pd-focusable"
          data-on={o.value === value ? 'true' : undefined}
          data-testid={testid !== undefined ? `${testid}-${o.value}` : undefined}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The empty state.
 *
 * It was two lines of grey text in the top-left corner of six hundred points of
 * nothing, and it spent them explaining the controls. It is now the centre of
 * the room, it says what this place MAKES, and — the part that actually teaches
 * — it offers three real prompts you can press. One press and the room has
 * shown you what it does instead of describing it.
 */
export function StudioEmpty({
  glyph,
  title,
  body,
  examples = [],
  onPick,
}: {
  glyph: ReactNode;
  title: string;
  body: string;
  examples?: readonly string[];
  onPick?: (example: string) => void;
}): JSX.Element {
  return (
    <div className="pd-studio-empty" data-testid="studio-empty">
      <div className="pd-studio-empty-glyph" aria-hidden="true">
        {glyph}
      </div>
      <h2 className="pd-studio-empty-title">{title}</h2>
      <p className="pd-studio-empty-body">{body}</p>
      {examples.length > 0 && onPick !== undefined ? (
        <div className="pd-studio-examples">
          {examples.map((e) => (
            <button
              key={e}
              type="button"
              className="pd-studio-example pd-focusable"
              data-testid="studio-example"
              onClick={() => onPick(e)}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
