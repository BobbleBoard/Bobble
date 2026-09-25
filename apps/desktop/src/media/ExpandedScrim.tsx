import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * THE APP'S "LOOK CLOSER AT THIS" GESTURE — one implementation.
 *
 * the user asked for the expanded view to cover input media too ("clicked inside
 * chat input or a user message log"), not just the generated cards. Rather than
 * a second, slightly-different overlay for pasted text and attachments, the one
 * MediaCard already had is extracted here and both use it.
 *
 * Everything below was learned by driving the first version:
 *
 *  - PORTALLED TO THE BODY, and it has to be. A card lives inside a scroll
 *    container that establishes a stacking context (transform/filter/contain),
 *    which makes `position: fixed` fix to IT rather than the viewport. MEASURED:
 *    the scrim was clipped at the composer's top edge. z-index cannot fix that.
 *  - `role="dialog"` + `aria-modal` is not decoration: StudioShell's Escape
 *    handler skips when a dialog is up by looking for exactly this role. Without
 *    it, closing an expanded picture also walked you out of the studio.
 *  - The chrome stands down. the user: "no to this thing at the bottom and no to the
 *    top bar staying here aswell." Faded rather than unmounted, so the composer
 *    does not reflow and lose whatever was typed in it — hence a flag on <body>,
 *    since the two things to quieten live in other subtrees.
 *  - `aria-modal` alone does not stop Tab: the page behind stayed focusable, so
 *    tabbing out of the image viewer's edit bar walked into the chat composer
 *    under the glass, and a keystroke meant for the viewer typed there. The app
 *    root is `inert` while this is up (the portal lives outside it), and focus
 *    goes back where it came from when it closes.
 *
 * TWO LAYOUTS. `stage` is the original: the media on a centred card with the
 * room blurred behind it. `room` hands the whole window to the children on the
 * studio's own ground — the image viewer, which lays out a tool rail, the
 * picture and an edit bar the way the studios do (ImageViewer.tsx).
 */
export function ExpandedScrim({
  label,
  onClose,
  children,
  testid = 'media-expanded',
  stageKind,
  layout = 'stage',
}: {
  /** Accessible name for the dialog (the file being looked at). */
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testid?: string;
  /** Sizes the stage — see `.pd-media-stage[data-kind=…]`. */
  readonly stageKind?: string;
  /** `stage`: a centred card. `room`: the children take the window. */
  readonly layout?: 'stage' | 'room';
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /* A menu or tooltip inside (the viewer's pickers) already used this
         Escape to close itself — Radix marks it handled. One press, one layer. */
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.setAttribute('data-media-expanded', 'true');
    return () => document.body.removeAttribute('data-media-expanded');
  }, []);

  /*
   * WHERE FOCUS CAME FROM, read while this first renders — before any child's
   * effect runs. Effects run children first, and the image viewer's edit bar
   * focuses itself in one, so by the time an effect of ours looked, "where it
   * came from" was that bar: gone on close, and focus fell to <body> instead of
   * going back to the composer (SEEN, attach-anything-probe, a picture chip
   * double-clicked and closed).
   */
  const [cameFrom] = useState(() => document.activeElement);
  // biome-ignore lint/correctness/useExhaustiveDependencies: held once for the scrim's life; cameFrom never changes
  useEffect(() => holdPageBehind(cameFrom), []);

  return createPortal(
    <div
      className="pd-media-scrim"
      data-testid={testid}
      data-layout={layout}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {/* The backdrop dismisses. A button rather than a div so Enter and Space
          close it too, without a keyboard shim. In a room it leaves the tab
          order: the room has a Close of its own, and a full-window "Close" stop
          in the middle of its tools would be noise. */}
      <button
        type="button"
        className="pd-media-scrim-hit"
        aria-label="Close"
        tabIndex={layout === 'room' ? -1 : undefined}
        onClick={onClose}
      />
      {layout === 'room' ? (
        children
      ) : (
        <div className="pd-media-stage" data-kind={stageKind}>
          {children}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Open scrims holding the page inert — nested ones share one hold. */
let holds = 0;

/**
 * Make the page behind the scrim inert, and hand focus back when it closes.
 *
 * Returns the release. Released FIRST, restored second: an inert element cannot
 * take focus, so restoring before lifting it would land on <body>.
 */
function holdPageBehind(cameFrom: Element | null): () => void {
  const root = document.getElementById('root');
  if (root === null) return () => undefined;
  holds += 1;
  root.inert = true;
  return () => {
    holds = Math.max(0, holds - 1);
    if (holds === 0) root.inert = false;
    const now = document.activeElement;
    // Only when nothing else has claimed focus since — never steal it back.
    if (
      (now === null || now === document.body) &&
      cameFrom instanceof HTMLElement &&
      cameFrom.isConnected
    ) {
      cameFrom.focus({ preventScroll: true });
    }
  };
}
