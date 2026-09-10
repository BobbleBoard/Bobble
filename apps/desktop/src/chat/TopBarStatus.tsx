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
     * A WRAPPER, because the card cannot live inside the button.
     *
     * The button is an inline-flex box, and an absolutely positioned child of a
     * flex container falls back to its STATIC position when the offsets do not
     * take — MEASURED, the card came back centred on the button at y=-120
     * (button centre 24, half the card 144) instead of at y=43 under it, and
     * did so intermittently, which is the worst version of that bug. Hanging it
     * off a plain relative wrapper removes the question.
     *
     * HOVERABLE, and focusable: the user asked for hover — "hover this pill at the
     * top for a bit of model information" — but a card that exists only under a
     * pointer does not exist for anyone on a keyboard.
     */
    <span
      className="pd-topbar-status-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="pd-topbar-status"
        data-kind={view.kind}
        data-testid="topbar-status"
        /* A real button, so focus, Enter and a screen reader all already work. */
        aria-expanded={open}
        aria-label={`${view.text}. Show model and engine details`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        /* NO click toggle. A pointer entering already opened the card, so a
           toggle on click shut it again — MEASURED, aria-expanded came back
           false immediately after a click. Hover and focus are the two ways in,
           and they agree. */
      >
        <Spinner size={12} />
        <span data-testid="topbar-status-text">{view.text}</span>
      </button>
      {open ? <TopBarModelCard /> : null}
    </span>
  );
}
