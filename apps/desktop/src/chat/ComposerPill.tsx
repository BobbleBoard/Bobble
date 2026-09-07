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
import { ContextGauge, Spinner } from '@pi-desktop/ui';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { composerPill } from './composer-pill';
import {
  modelReadyStage,
  PREFILL_STATUS_KEY,
  PREFIX_WARM_STATUS,
  parsePrefillPercent,
} from './harness-status';
import { IconWarning } from './icons-pill';

export function ComposerPill({ imageOnBlindModel = false }: { imageOnBlindModel?: boolean }) {
  const prefixWarm = usePiStore((s) => s.extensionStatus[PREFIX_WARM_STATUS]);
  const readyStage = useLlmStore((s) => modelReadyStage(s.status.phase, prefixWarm));
  const prefillPercent = parsePrefillPercent(
    usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]),
  );

  const view = composerPill({ readyStage, prefillPercent, imageOnBlindModel });
  if (view === null) return null;

  return (
    <div
      className="pd-composer-pill"
      data-tone={view.tone}
      data-kind={view.kind}
      data-testid="composer-pill"
    >
      {view.tone === 'warn' ? (
        <IconWarning size={13} />
      ) : view.percent === null ? (
        <Spinner size={12} />
      ) : (
        <ContextGauge
          value={view.percent / 100}
          size={13}
          tone="muted"
          label={`${view.percent}%`}
        />
      )}
      <span data-testid="composer-pill-text">
        {view.percent === null ? view.text : `${view.text} · ${Math.round(view.percent)}%`}
      </span>
    </div>
  );
}
