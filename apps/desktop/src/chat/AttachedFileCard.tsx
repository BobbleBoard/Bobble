import { FileGlyph, FolderGlyph, IconClose, Spinner } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ExpandedScrim } from '../media/ExpandedScrim';
import { revealFile } from '../media/media-actions';

/**
 * A text attachment, as a card you can open.
 *
 * The user, on the paste card: "make it clickable to show semi-fullscreen (centered,
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
   * The user: "the loading spinner can still be on them, it disapears when they are
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

/**
 * A file or folder the message named by its PATH — a PDF, a zip, a project
 * folder: nothing the prompt can carry, everything the model's tools can open.
 *
 * The user: "why not handle this natively so that any image(s)/files/folders...
 * can be pasted into the input box". The card says what it is the way Finder
 * would — the page with its extension on it, or the folder — its name, and
 * what it is. The whole face is a button that shows it in Finder: a reference
 * is a place on disk, and that is where it takes you.
 *
 * Same family as the paste card above (border, surface, radius), shorter,
 * because there is no text to preview.
 */
export function AttachedPathCard({
  kind,
  name,
  path,
  detail,
  onRemove,
}: {
  readonly kind: 'file' | 'folder' | 'image';
  readonly name: string;
  readonly path: string;
  /** What it is — `PDF, 2.3 MB`; a folder says "Folder". */
  readonly detail?: string;
  readonly onRemove?: () => void;
}): ReactNode {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (
    <div className="pd-pathcard" data-kind={kind} data-path={path} data-testid="attached-path">
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
      <button
        type="button"
        className="pd-pathcard-open pd-focusable"
        aria-label={`Show ${name} in Finder`}
        title={`Show in Finder · ${path}`}
        onClick={() => revealFile(path)}
      >
        <span className="pd-pathcard-tile" aria-hidden="true">
          {kind === 'folder' ? (
            <FolderGlyph open={false} size={22} />
          ) : (
            <FileGlyph ext={ext} size={22} />
          )}
        </span>
        <span className="pd-pathcard-text">
          <span className="pd-pathcard-name">{name}</span>
          <span className="pd-pathcard-meta">
            {kind === 'folder' ? 'Folder' : (detail ?? '').replace(/, /g, ' · ')}
          </span>
        </span>
      </button>
    </div>
  );
}
