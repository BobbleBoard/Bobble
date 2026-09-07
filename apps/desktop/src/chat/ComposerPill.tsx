/**
 * The pill above the input bar.
 *
 * the user: "moving to a new chat shows this 'getting ready' thing that I'd like to
 * move to a pill that floats above the input bar we can use" — and then he uses
 * it again himself, for the image warning. So it is one component with one
 * position, not a status line that happens to be near the composer.
 *
 * FLOATS, and that is load-bearing: it is absolutely positioned above the card,
 * so it appears and disappears without moving the thing you are typing into.
 * Every version of this that took layout space would push the composer down and
 * back up on a state change nobody asked for.
 *
 * The ring vs spinner rule lives in {@link composerPill} — a ring ONLY where a
 * real number exists.
 */
import { Spinner } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { recordBootWait, typicalBootSeconds } from './boot-history';
import { composerPill } from './composer-pill';
import {
  modelReadyStage,
  PREFILL_STATUS_KEY,
  PREFIX_WARM_STATUS,
  parsePrefillPercent,
} from './harness-status';
import { IconWarning } from './icons-pill';

/**
 * Milliseconds in the current wait, and — when it ends — how long it took.
 *
 * The clock is what makes the spinner honest ("the changing digits are what
 * reassures me"), and finishing is where the estimate for NEXT time comes from,
 * so both live in one hook: it counts up, then writes the result down.
 */
function useWaitClock(stage: 'loading' | 'preparing' | null): number | null {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const prev = useRef<'loading' | 'preparing' | null>(null);

  useEffect(() => {
    if (stage === prev.current) return;
    // A wait that just ENDED is a measurement — this is where "usually about 8s
    // on this Mac" comes from, two launches later.
    if (prev.current !== null && since !== null) {
      recordBootWait(
        prev.current === 'loading' ? 'model-load' : 'prompt-load',
        (Date.now() - since) / 1000,
      );
    }
    prev.current = stage;
    setSince(stage === null ? null : Date.now());
    setNow(Date.now());
  }, [stage, since]);

  useEffect(() => {
    if (stage === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage]);

  return stage === null || since === null ? null : now - since;
}

export function ComposerPill({ imageOnBlindModel = false }: { imageOnBlindModel?: boolean }) {
  const prefixWarm = usePiStore((s) => s.extensionStatus[PREFIX_WARM_STATUS]);
  const readyStage = useLlmStore((s) => modelReadyStage(s.status.phase, prefixWarm));
  const elapsedMs = useWaitClock(readyStage);
  const typicalSec =
    readyStage === null
      ? null
      : typicalBootSeconds(readyStage === 'loading' ? 'model-load' : 'prompt-load');

  const view = composerPill({ readyStage, imageOnBlindModel, elapsedMs, typicalSec });
  if (view === null) return null;

  return (
    <div
      className="pd-composer-pill"
      data-tone={view.tone}
      data-kind={view.kind}
      data-testid="composer-pill"
    >
      {/* Always a spinner here now: neither boot wait has a real number, and the
          turn's own prefill — the one that does — moved back to the thread with
          the message it belongs to. The honesty is in the clock, not the ring. */}
      {view.tone === 'warn' ? <IconWarning size={13} /> : <Spinner size={12} />}
      <span data-testid="composer-pill-text">{view.text}</span>
    </div>
  );
}
