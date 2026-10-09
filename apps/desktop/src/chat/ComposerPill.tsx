/**
 * The pill above the input bar.
 *
 * The user: "moving to a new chat shows this 'getting ready' thing that I'd like to
 * move to a pill that floats above the input bar we can use" — and then the user uses
 * it again themselves, for the image warning. So it is one component with one
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
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { useViewedAsk } from './AskCard';
import { typicalBootSeconds } from './boot-history';
import { composerPill, pickPill } from './composer-pill';
import { modelReadyStage, PREFIX_WARM_STATUS } from './harness-status';
import { IconWarning } from './icons-pill';
import { usePillStore } from './pill-store';
import { useRePrefillWarning } from './use-reprefill-warning';
import { useWaitClock } from './use-wait-clock';

export function ComposerPill({
  imageOnBlindModel = false,
}: {
  imageOnBlindModel?: boolean | 'off' | 'unsupported';
}) {
  /*
   * The one thing in this app that CANNOT be made instant, said out loud before
   * it costs you. The user: "flagged to the user to my face right there whenever
   * anything threatens to cause a full re prefill (including model switches) at
   * over 16k context." It publishes into the slot below like anything else.
   */
  useRePrefillWarning();
  // A question to the person stands where the pill would float: the pill steps aside.
  const asking = useViewedAsk() !== null;
  const prefixWarm = usePiStore((s) => s.extensionStatus[PREFIX_WARM_STATUS]);
  const readyStage = useLlmStore((s) => modelReadyStage(s.status.phase, prefixWarm));
  const elapsedMs = useWaitClock(readyStage);
  const typicalSec =
    readyStage === null
      ? null
      : typicalBootSeconds(readyStage === 'loading' ? 'model-load' : 'prompt-load');

  /*
   * THE BOOT WAITS ARE NOT HERE ANY MORE.
   *
   * The user: "remove the 'starting up' pill and put it instead in the top bar
   * centered." They are about the APP coming up, not about the message you are
   * typing, and a pill above the composer put them in the wrong place twice
   * over — it hovered over what you were writing, and it went away the moment
   * you looked at anything else. TopBarStatus owns them now; this slot keeps
   * what is genuinely about the composer (the image warning) and whatever the
   * rest of the app publishes into it.
   */
  const boot = composerPill({ readyStage, imageOnBlindModel, elapsedMs, typicalSec });
  const derived = boot !== null && boot.kind !== 'no-vision' ? null : boot;
  /*
   * THE SLOT, NOT A SWITCH. Anything in the app can publish here (pill-store),
   * and the derived waits are simply candidates with a high priority — a model
   * that cannot answer outranks anything about a message it has not been asked
   * yet. See `pickPill` for why there is only ever one.
   */
  const published = usePillStore((s) => s.pills);
  const view = pickPill([
    ...published.map((p) => ({
      text: p.text,
      tone: p.tone,
      spinner: p.spinner === true,
      priority: p.priority ?? 50,
      kind: p.id,
    })),
    ...(derived === null
      ? []
      : [
          {
            text: derived.text,
            tone: derived.tone,
            spinner: derived.tone === 'busy',
            priority: 100,
            kind: derived.kind,
          },
        ]),
  ]);
  if (view === null || asking) return null;

  return (
    <div
      className="pd-composer-pill"
      data-tone={view.tone}
      data-kind={view.kind}
      data-testid="composer-pill"
    >
      {/* A spinner for anything in progress; the warning mark otherwise. Neither
          boot wait has a real number — the turn's own prefill, the one that
          does, moved back to the thread with the message it belongs to. The
          honesty is in the clock, not in a ring. */}
      {view.spinner === true ? <Spinner size={12} /> : <IconWarning size={13} />}
      <span data-testid="composer-pill-text">{view.text}</span>
    </div>
  );
}
