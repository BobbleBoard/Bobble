/**
 * THE FRAME EVERY STUDIO SHARES.
 *
 * Three studios that each invented their own header, their own prompt box and
 * their own results strip would drift within a week — and they are the same
 * program three times: describe a thing, set a few knobs, press the button,
 * wait, look at what came out, keep or discard it. Only the knobs differ.
 *
 * So the shell owns the parts that are identical (identity, back, the prompt
 * row, the run button and its busy state, the error line, the results area) and
 * each studio supplies only its own controls and its own result renderer.
 *
 * WHY THE PROMPT IS AT THE TOP AND RESULTS BELOW, rather than the chat-like
 * inverse: a studio is not a conversation. You are iterating on ONE description,
 * changing a knob and going again, so the description must stay put under your
 * hands while the output changes below it. Putting the input at the bottom would
 * move it every time the results grew.
 */
import { Button, IconChevronLeft, ScrollArea, Spinner } from '@pi-desktop/ui';
import type { JSX, ReactNode } from 'react';
import { exitModality } from '../state/modality-store';

export interface StudioShellProps {
  readonly title: string;
  readonly subtitle: string;
  /** The studio's own controls, right of the prompt. */
  readonly controls: ReactNode;
  /** Extra controls that sit under the prompt (mode switches, etc). */
  readonly abovePrompt?: ReactNode;
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
  subtitle,
  controls,
  abovePrompt,
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
        <div className="min-w-0">
          <h1 className="pd-studio-title">{title}</h1>
          <p className="pd-studio-sub">{subtitle}</p>
        </div>
      </header>

      <div className="pd-studio-compose">
        {abovePrompt !== undefined ? <div className="pd-studio-modes">{abovePrompt}</div> : null}

        <div className="pd-studio-prompt-row">
          {multiline ? (
            <textarea
              className="pd-studio-prompt pd-studio-prompt--multi pd-focusable"
              data-testid="studio-prompt"
              value={prompt}
              placeholder={placeholder}
              onChange={(e) => onPrompt(e.target.value)}
              rows={4}
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
            DISABLED run button at 0.5 opacity was still the brightest object on
            the screen, advancing when it should recede. Accent is the blue the
            model hub already standardised on for "do the thing", and it dims
            correctly.
          */}
          <Button
            variant="accent"
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="pd-studio-results" data-testid="studio-results">
          {children}
        </div>
      </ScrollArea>
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
 * The empty state.
 *
 * Says what this studio makes rather than "no results yet" — the first thing a
 * new user sees should teach the room, not report the obvious.
 */
export function StudioEmpty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="pd-studio-empty" data-testid="studio-empty">
      {children}
    </div>
  );
}
