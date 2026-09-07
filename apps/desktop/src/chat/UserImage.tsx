import type { ReactNode } from 'react';
import { useState } from 'react';
import { ExpandedScrim } from '../media/ExpandedScrim';
import { useImagesUnsupported } from '../state/local-model';
import { IconWarning } from './icons-pill';

/**
 * An image the USER attached, in their own message — click to look closer.
 *
 * the user asked for the expanded view on "all input media (clicked inside chat
 * input or a user message log)", not only on generated output. A 128px-tall
 * thumbnail of a screenshot you sent is unreadable, and there was no way to open
 * it: the only way to see what you had actually attached was to find the file
 * again. Same scrim as every other card, so the gesture is one gesture.
 */
export function UserImage({
  src,
  name = 'Attached image',
}: {
  src: string;
  name?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  /*
   * A PICTURE THE MODEL COULD NOT READ SAYS SO, FOREVER.
   *
   * the user: "a yellow circle + ! on images both in chat input and when sent." The
   * pill above the composer is gone a moment later; this is what is still there
   * when you scroll back a week from now and wonder why the answer ignored the
   * screenshot. Read live rather than stored on the message, so switching to a
   * model that CAN see clears it.
   */
  const blind = useImagesUnsupported();
  return (
    <>
      <span className="pd-blind-host">
        <button
          type="button"
          className="pd-user-image pd-focusable"
          aria-label={`Open ${name}`}
          onClick={() => setOpen(true)}
        >
          {/* biome-ignore lint/a11y/useAltText: the button carries the label */}
          <img src={src} className="max-h-32 rounded-md" />
        </button>
        {blind ? (
          <span
            className="pd-blind-badge"
            data-testid="user-image-blind-badge"
            title="The selected model cannot read images"
          >
            <IconWarning size={14} />
          </span>
        ) : null}
      </span>
      {open ? (
        <ExpandedScrim label={name} testid="user-image-expanded" onClose={() => setOpen(false)}>
          {/* biome-ignore lint/a11y/useAltText: the dialog carries the label */}
          <img src={src} className="pd-media-image" />
        </ExpandedScrim>
      ) : null}
    </>
  );
}

/**
 * "This model couldn't see the image." — the sentence under a sent picture the
 * running model cannot read.
 *
 * The yellow disc on the picture catches the eye; this says what it means. The
 * tester, on the badge alone: "a coloured mark whose meaning I have to be taught
 * is the 'No project' chip all over again — right instinct, and you're one
 * sentence from it being right."
 *
 * Renders nothing when the model CAN see, and re-evaluates live, so switching to
 * a vision-capable model clears both the badge and this line together.
 */
export function BlindImageNote(): ReactNode {
  const blind = useImagesUnsupported();
  if (!blind) return null;
  return (
    <span className="text-caption text-text-muted" data-testid="blind-image-note">
      This model couldn’t see the image.
    </span>
  );
}
