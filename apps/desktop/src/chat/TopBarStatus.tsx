/**
 * WHAT THE APP IS DOING, in the middle of the top bar.
 *
 * the user: "remove the 'starting up' pill and put it instead in the top bar
 * centered, centered in the top bar between new chat and canvas
 * controls/advanced settings."
 *
 * It used to hover above the composer, which put it in the wrong place twice
 * over: it sat on top of what you were writing, and it belonged to the chat
 * pane, so it vanished the moment you looked at a studio or the model hub —
 * while the model was still, in fact, loading. The top bar is on screen
 * whatever you are looking at, and its centre slot was empty.
 *
 * The clock and the estimate come with it unchanged (see useWaitClock): a
 * spinner alone starts reading as stuck at about four seconds, and the digits
 * going up are the part that reassures.
 */
import { Spinner } from '@pi-desktop/ui';
import { useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { typicalBootSeconds } from './boot-history';
import { composerPill } from './composer-pill';
import { modelReadyStage, PREFIX_WARM_STATUS } from './harness-status';
import { TopBarModelCard } from './TopBarModelCard';
import { useWaitClock } from './use-wait-clock';

export function TopBarStatus() {
  const [open, setOpen] = useState(false);
  const prefixWarm = usePiStore((s) => s.extensionStatus[PREFIX_WARM_STATUS]);
  const readyStage = useLlmStore((s) => modelReadyStage(s.status.phase, prefixWarm));
  const elapsedMs = useWaitClock(readyStage);
  const typicalSec =
    readyStage === null
      ? null
      : typicalBootSeconds(readyStage === 'loading' ? 'model-load' : 'prompt-load');

  /* The same state machine the pill used, asked only for the two waits that are
     about the app rather than about the message. */
  const view = composerPill({ readyStage, imageOnBlindModel: false, elapsedMs, typicalSec });
  if (view === null || view.kind === 'no-vision') return null;

  return (
    /*
     * HOVERABLE, so it has to stop being pointer-transparent — the user: "hover this
     * pill at the top for a bit of model information". Focus opens it too: a
     * card that only exists under a pointer does not exist for anyone driving
     * this from the keyboard.
     */
    <div
      className="pd-topbar-status"
      data-kind={view.kind}
      data-testid="topbar-status"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      <Spinner size={12} />
      <span data-testid="topbar-status-text">{view.text}</span>
      {open ? <TopBarModelCard /> : null}
    </div>
  );
}
