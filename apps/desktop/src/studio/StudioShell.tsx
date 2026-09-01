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
 * THE SHAPE IS THE CHAT'S SHAPE, ON PURPOSE.
 *
 * A studio is not a window of its own any more: it renders where the chat
 * renders, under the same top bar, with the sidebar sliding in over its left
 * edge. So it is built out of the same three parts the chat is — a scrolling
 * body, a docked composer at the bottom, and panels that open from the two
 * top-right buttons — because the user asked for exactly that ("very clean
 * minimalist similar styling to the main chat area I like that UI a lot") and
 * because a person who has learnt the chat has then already learnt this.
 *
 * WHAT GOES WHERE. The composer carries the description and at most a couple of
 * knobs you flip between two runs of one idea. The SETTINGS RAIL on the right
 * carries what the studio is set to — mode, preset, voice, shape, size. The
 * GEARS carry sampling and steps. Three tiers, and the rule for placing a
 * control is how often you touch it, not how important it sounds.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconChevronDown,
  ScrollArea,
  Spinner,
} from '@pi-desktop/ui';
import { type JSX, type ReactNode, useEffect } from 'react';
import { exitModality } from '../state/modality-store';
import { useStudioUiStore } from './studio-ui-store';

export interface StudioShellProps {
  /* No `title`. The room's name is drawn by the app's top bar, from ChatApp's
     own STUDIO_TITLES — the shell took one too and then had nowhere to put it
     once the gears dialog started saying plain "Advanced". */
  /**
   * The one or two controls that belong ON the input bar — the things you
   * change between two runs of the same idea. Everything else lives in the
   * settings rail; a composer with eight knobs on it is a form, not a prompt.
   */
  readonly controls?: ReactNode;
  /**
   * The right-hand SETTINGS RAIL: modes, presets, shape, voice — the common
   * things a studio is configured with. Opened from the top bar, in the same
   * place and with the same icon as the canvas.
   */
  readonly settings?: ReactNode;
  /**
   * The GEARS panel: sampling, steps, seeds. The knobs someone reaches for on
   * purpose, kept off the surface everyone else uses.
   */
  readonly advanced?: ReactNode;
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
  controls,
  settings,
  advanced,
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
  const settingsOpen = useStudioUiStore((s) => s.settingsOpen);
  const advancedOpen = useStudioUiStore((s) => s.advancedOpen);
  const setAdvancedOpen = useStudioUiStore((s) => s.setAdvancedOpen);
  const resetPanels = useStudioUiStore((s) => s.reset);

  // Leaving closes both. Which panel you had open is a property of the sitting,
  // not of the app, and arriving to a rail you do not remember opening is worse
  // than arriving to none.
  useEffect(() => resetPanels, [resetPanels]);

  /*
   * ESCAPE GOES BACK TO THE CHAT. The studio no longer takes the window — it
   * replaces the chat content, and the sidebar is a click away — but Escape is
   * still the cheapest way out and costs nothing to keep. Ignored while a menu
   * or dialog is up, so it never steals a dismissal that belongs to something
   * in front of it.
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
      {/*
        THE WORKING COLUMN — results above, input bar below.
        The RAIL is its sibling, not its parent's overlay, so opening the rail
        narrows the results AND the composer together. Nesting the rail inside
        the scrolling half instead left the composer centred on the window while
        everything above it had shifted left, which reads as the input bar
        sliding under the panel.
      */}
      <div className="pd-studio-main">
        <ScrollArea className="pd-studio-canvas">
          <div className="pd-studio-results" data-testid="studio-results">
            {children}
          </div>
        </ScrollArea>

        {/*
          THE INPUT BAR — one box, and no panel around it.
          the user: "no 'seperate area' for the input bar and settings on the
          bottom, send button to the right of the input bar and fit options
          below compact and in dropups". It used to be a bordered, filled strip
          holding a field AND a row of labelled pill groups, which read as a
          settings panel that happened to contain a prompt. Now the box is the
          field plus its run button, and the choices sit under it as small
          value-stating buttons on the page's own background.
        */}
        <div className="pd-studio-compose">
          <div className="pd-studio-composer">
            {multiline ? (
              <textarea
                className="pd-studio-prompt pd-studio-prompt--multi pd-focusable"
                data-testid="studio-prompt"
                value={prompt}
                placeholder={placeholder}
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘↩ runs; plain Enter is a newline, because here you are
                  // typing a paragraph.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) {
                    e.preventDefault();
                    onRun();
                  }
                }}
                rows={2}
              />
            ) : (
              <input
                className="pd-studio-prompt pd-focusable"
                data-testid="studio-prompt"
                value={prompt}
                placeholder={placeholder}
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Enter runs: a one-line description is a thing you finish
                  // typing, not a field you tab out of.
                  if (e.key === 'Enter' && canRun) onRun();
                }}
              />
            )}
            {/*
              ACCENT, NOT PRIMARY. `.pd-btn--primary` is `background:
              var(--pd-text-primary)` — a WHITE block on the dark themes — so a
              DISABLED run button was still the brightest object on the screen.
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
                <span className="flex items-center gap-1.5">
                  <Spinner size={12} /> Working…
                </span>
              ) : (
                runLabel
              )}
            </Button>
          </div>

          {controls !== undefined ? (
            <div className="pd-studio-underbar" data-testid="studio-underbar">
              {controls}
            </div>
          ) : null}

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

      {/*
        THE SETTINGS RAIL, on the right, opened from the top bar. Narrower than
        the canvas: these are knobs, not content. The sidebar on the far left
        and this one on the right frame the work rather than stacking on it.
      */}
      {settings !== undefined ? (
        <div className="pd-studio-rail" data-open={settingsOpen} data-testid="studio-settings">
          <div className="pd-studio-rail-inner">{settings}</div>
        </div>
      ) : null}

      {/* The gears. A dialog rather than a second rail: these are read-and-set,
          not watched, and two rails open at once is a control panel. */}
      {advanced !== undefined ? (
        <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <DialogContent data-testid="studio-advanced" className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>Advanced</DialogTitle>
            </DialogHeader>
            {/* `.pd-dialog-body` is where the padding and the scroll live —
                without it the fields sat against the panel's edges and a long
                note ran straight out of the bottom. */}
            <div className="pd-dialog-body pd-studio-advanced">{advanced}</div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * A COMPACT PICKER FOR THE BAR UNDER THE COMPOSER — label, value, and a menu
 * that opens UPWARD.
 *
 * The composer used to carry `Knob` + `Segmented`: a stacked caption over a row
 * of pills, three or four of them side by side, inside a panel with its own
 * border and background. That is a settings form sitting under the place you
 * type, and it made the bottom of every studio taller than the thing it was
 * attached to. the user, with the Claude composer as the reference: "no 'seperate
 * area' for the input bar and settings on the bottom, send button to the right
 * of the input bar and fit options below compact and in dropups or such".
 *
 * So each choice collapses to one small button that STATES ITS CURRENT VALUE —
 * which is the part a form of pills does badly, because you have to find the lit
 * one to know where you are. Upward, because the bar sits at the bottom of the
 * window and a menu that drops off the screen has to be flipped by the collision
 * logic anyway; asking for it directly is steadier.
 */
export function StudioPicker<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testid,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  testid?: string;
}): JSX.Element {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="pd-studio-pick pd-focusable" data-testid={testid}>
          <span className="pd-studio-pick-label">{label}</span>
          <span className="pd-studio-pick-value">{current?.label ?? String(value)}</span>
          <IconChevronDown size={12} className="pd-studio-pick-caret" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[170px]">
        <DropdownMenuRadioGroup
          value={String(value)}
          onValueChange={(next) => {
            const picked = options.find((o) => String(o.value) === next);
            if (picked !== undefined) onChange(picked.value);
          }}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem
              key={String(o.value)}
              value={String(o.value)}
              data-testid={testid !== undefined ? `${testid}-${o.value}` : undefined}
            >
              <span className="flex flex-col">
                <span>{o.label}</span>
                {o.hint !== undefined ? (
                  <span className="pd-studio-pick-hint">{o.hint}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A titled group in the settings rail.
 *
 * The rail is a column of unrelated knobs, and unrelated knobs in a column read
 * as one long form. Two or three headings turn it back into a settings panel you
 * can skim for the thing you came to change.
 */
export function RailGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="pd-studio-rail-head">{title}</div>
      {children}
    </div>
  );
}

/**
 * An on/off row: label on the left, switch on the right.
 *
 * Deliberately NOT a `Knob` with a checkbox in it — a boolean setting is read as
 * a statement you agree or disagree with, and putting the switch on the far
 * right of the row makes a column of them scannable in one pass.
 */
export function RailToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  testid,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testid?: string;
}): JSX.Element {
  return (
    <label className="pd-studio-toggle" data-disabled={disabled === true ? 'true' : undefined}>
      <span className="min-w-0">
        <span className="pd-studio-toggle-label">{label}</span>
        {hint !== undefined ? <span className="pd-studio-toggle-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="pd-studio-switch pd-focusable"
        role="switch"
        // A native checkbox already carries its state, but `role="switch"`
        // replaces the implicit role — so the state has to be restated for it.
        aria-checked={checked}
        data-testid={testid}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** A labelled knob. Keeps every control in every studio the same shape. */
export function Knob({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    /* Wrapping DOES associate: every Knob's child is a native control, and a
       label that contains one is bound to it by the browser. The rule fires
       because it cannot see through `children` to know that. Switching to
       `htmlFor` would mean inventing an id at each of the studios' ~20 call
       sites for no gain a screen reader could notice. */
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`, a native input.
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
        /* A segmented control is buttons with `role="radio"` inside a
           `role="radiogroup"` — the standard ARIA pattern. `<input
           type="radio">`, which the rule wants, cannot carry this styling and
           would change every studio's appearance to satisfy a lint the roles
           already answer. */
        // biome-ignore lint/a11y/useSemanticElements: radiogroup pattern, styled.
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
/**
 * ONE STARTING POINT. Icon, name, and what it is for — the card a studio's empty
 * room is made of.
 *
 * A starter is not a prompt, it is a TASK: pressing "Clone a voice" puts the
 * room into the shape that task needs (the right mode, the right knobs) and
 * leaves a first line in the composer for you to replace. The old empty state
 * offered three example sentences, which taught you what to type and nothing
 * about what the room could do — you could not tell from looking at the audio
 * studio that it clones voices at all.
 */
export interface StudioStarter {
  readonly id: string;
  /** The SVG glyph, drawn in the same weight as the room's own big one. */
  readonly icon: ReactNode;
  readonly title: string;
  readonly hint: string;
  /** Configure the room for this task. */
  readonly onPick: () => void;
}

export function StudioEmpty({
  glyph,
  title,
  body,
  starters = [],
}: {
  glyph: ReactNode;
  title: string;
  body: string;
  /**
   * The three cards. Side by side, centred — the room's own menu.
   *
   * These REPLACED a row of example prompt pills. Both at once was two menus
   * stacked: the pills seeded a sentence, and every card seeds a sentence too,
   * on top of setting the knobs that sentence needs. Keeping both made the
   * empty room busier than the full one.
   */
  starters?: readonly StudioStarter[];
}): JSX.Element {
  return (
    <div className="pd-studio-empty" data-testid="studio-empty">
      <div className="pd-studio-empty-glyph" aria-hidden="true">
        {glyph}
      </div>
      <h2 className="pd-studio-empty-title">{title}</h2>
      <p className="pd-studio-empty-body">{body}</p>
      {starters.length > 0 ? (
        <div className="pd-studio-starters" data-testid="studio-starters">
          {starters.map((st) => (
            <button
              key={st.id}
              type="button"
              className="pd-studio-starter pd-focusable"
              data-testid={`studio-starter-${st.id}`}
              onClick={st.onPick}
            >
              <span className="pd-studio-starter-icon" aria-hidden="true">
                {st.icon}
              </span>
              <span className="pd-studio-starter-title">{st.title}</span>
              <span className="pd-studio-starter-hint">{st.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
