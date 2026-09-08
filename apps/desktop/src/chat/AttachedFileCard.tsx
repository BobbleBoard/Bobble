import { IconClose, Spinner } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ExpandedScrim } from '../media/ExpandedScrim';

/**
 * A text attachment, as a card you can open.
 *
 * the user, on the paste card: "make it clickable to show semi-fullscreen (centered,
 * background blurred), the same for all input media (clicked inside chat input
 * or a user message log) and output media."
 *
 * The card was preview-only — six clamped lines of a paste that might be two
 * hundred, with no way to check what you had actually attached before sending
 * it. Clicking now opens the full text in the same scrim the generated media
 * cards use, so "look closer at this" is one gesture everywhere.
 *
 * Used in two places with the same shape: live in the composer (with a remove
 * button) and in a sent user message rebuilt from the session file (without).
 */
export function AttachedFileCard({
  name,
  text,
  onRemove,
  prefilling = false,
}: {
  readonly name: string;
  readonly text: string;
  /** Shown only in the composer — a sent message cannot be un-attached. */
  readonly onRemove?: () => void;
  /**
   * Its contents are still being read into the model.
   *
   * True in the composer while the prime runs, and — the part that was missing —
   * still true on the copy in the thread until the sent turn is past prefill.
   * the user: "the loading spinner can still be on them, it disapears when they are
   * prefilled." See chat/sent-prefill.ts for what decides it after send.
   */
  readonly prefilling?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  // A short prefix is enough for the preview; CSS line-clamps it to a few rows.
  const preview = text.slice(0, 400);
  const pasted = name === 'pasted content';
  return (
    <>
      <div className="pd-pasted">
        {onRemove !== undefined ? (
          <button
            type="button"
            className="pd-pasted-remove pd-focusable"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            <IconClose size={12} />
          </button>
        ) : null}
        {/* The card itself is the button — the whole face is the target, which is
            what "clickable" means for something this size. */}
        <button
          type="button"
          className="pd-pasted-open pd-focusable"
          aria-label={`Open ${name}`}
          title={pasted ? 'Pasted content' : name}
          onClick={() => setOpen(true)}
        >
          <span className="pd-pasted-preview">{preview}</span>
          {/* The badge row carries the state, the way the composer chip's meta
              row does: the spinner sits beside the name rather than over the
              preview, so the card does not change size when it clears. */}
          <span className="pd-pasted-foot">
            <span className="pd-pasted-badge">{pasted ? 'PASTED' : name}</span>
            {prefilling ? (
              <span
                className="pd-pasted-prefill"
                data-testid="attach-prefilling"
                title="Still being read into the model"
              >
                <Spinner size={11} />
              </span>
            ) : null}
          </span>
        </button>
      </div>
      {open ? (
        <ExpandedScrim
          label={name}
          testid="attached-file-expanded"
          stageKind="text"
          onClose={() => setOpen(false)}
        >
          <div className="pd-pasted-stage">
            <div className="pd-pasted-stage-title">{pasted ? 'Pasted content' : name}</div>
            <pre className="pd-pasted-stage-body">{text}</pre>
          </div>
        </ExpandedScrim>
      ) : null}
    </>
  );
}
