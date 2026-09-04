import type { ReactNode } from 'react';
import { useEffect } from 'react';
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
 */
export function ExpandedScrim({
  label,
  onClose,
  children,
  testid = 'media-expanded',
  stageKind,
}: {
  /** Accessible name for the dialog (the file being looked at). */
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testid?: string;
  /** Sizes the stage — see `.pd-media-stage[data-kind=…]`. */
  readonly stageKind?: string;
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
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

  return createPortal(
    <div
      className="pd-media-scrim"
      data-testid={testid}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {/* The backdrop dismisses. A button rather than a div so Enter and Space
          close it too, without a keyboard shim. */}
      <button type="button" className="pd-media-scrim-hit" aria-label="Close" onClick={onClose} />
      <div className="pd-media-stage" data-kind={stageKind}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
