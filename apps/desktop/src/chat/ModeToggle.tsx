/**
 * CHAT | PROJECT — the two-segment control beside the traffic lights.
 *
 * the user: "claude has this little thing in the top left that I think we can lift
 * off of … that toggles that bottom bar popping out, left one being 'chat' and
 * right being 'work'."
 *
 * It answers a note the blind tester gave twice: "No project" and "Effort ·
 * Adaptive" sit on the opening screen and both need a sentence of explanation to
 * a normal person. Her fix was to put them behind the gear. This is better, and
 * it is the user's: behind a MODE. Nothing is hidden — the control that reveals them
 * is on screen, permanently, and it also tells you which of the two things this
 * app is you are currently doing.
 *
 * The bar itself does the sliding (see `.pd-composer-bar` in global.css); this
 * only owns the choice.
 */
import { IconChat, IconCode } from '@pi-desktop/ui';
import { setWorkMode, useWorkMode } from '../state/settings-store';

export function ModeToggle(): React.ReactElement {
  const mode = useWorkMode();
  return (
    /* A fieldset is the semantic version of "these two belong together", so the
     * label rides a legend rather than an aria-label on a div. */
    <fieldset className="pd-mode-toggle" data-testid="mode-toggle" data-mode={mode}>
      <legend className="sr-only">Chat or project</legend>
      <button
        type="button"
        className="pd-mode-seg pd-focusable"
        aria-pressed={mode === 'chat'}
        title="Chat — just the conversation"
        aria-label="Chat"
        data-testid="mode-chat"
        onClick={() => void setWorkMode('chat')}
      >
        <IconChat size={15} />
      </button>
      <button
        type="button"
        className="pd-mode-seg pd-focusable"
        aria-pressed={mode === 'work'}
        title="Project — a folder on your Mac, with its context and effort"
        aria-label="Project"
        data-testid="mode-work"
        onClick={() => void setWorkMode('work')}
      >
        <IconCode size={15} />
      </button>
    </fieldset>
  );
}
