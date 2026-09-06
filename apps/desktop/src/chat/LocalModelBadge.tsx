/**
 * The sidebar's local-model line: "Running on your Mac" over the model name in
 * grey, with a dot for loaded / loading / off.
 *
 * WHY IT IS HERE AND NOT IN THE COMPOSER. The composer chip names *what you
 * chose* and is a control. This is neither — it is the app saying what it is and
 * whether it is awake, in the one place that is on screen before you have typed
 * anything. The blind tester opened the app, read the greeting, looked at the
 * sidebar and had no idea a model was already loading for her; ten seconds of
 * free warm-up went by looking exactly like ten seconds of nothing.
 *
 * See {@link localStatusView} for the copy rules (no percentages, elapsed count).
 */
import { useEffect, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { useModelSelectionStore } from '../state/model-selection-store';
import { type LocalDot, localStatusView } from './local-status';

/* Real theme tokens only — an invented `--pd-accent-*` name paints nothing and
 * the token-hygiene test would (rightly) fail it. */
const DOT_CLASS: Record<LocalDot, string> = {
  ready: 'bg-status-success-fg',
  working: 'bg-status-warning-fg pd-local-dot--pulse',
  off: 'bg-text-muted opacity-50',
  error: 'bg-status-danger-fg',
};

/**
 * Milliseconds since `phase` last changed. Kept in this component (not the
 * store) because it is presentation: a counter that resets when the app decides
 * something new is happening, and ticks once a second so the number is always
 * moving while the user is looking at it.
 */
function usePhaseElapsed(phase: string, active: boolean): number | null {
  const [since, setSince] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  // `phase` is the ONLY dependency on purpose: the counter restarts when the app
  // decides something new is happening, not when React re-renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart on phase change is the behaviour
  useEffect(() => {
    setSince(Date.now());
    setNow(Date.now());
  }, [phase]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now - since : null;
}

export function LocalModelBadge(): React.ReactElement {
  const phase = useLlmStore((s) => s.status.phase);
  const loadedName = useLlmStore((s) => s.status.model?.displayName ?? null);
  // What is COMING: the switching banner names it before the server reports it,
  // so a starting model has something to put in the grey line.
  const switchingTo = useModelSelectionStore((s) => s.switching?.toName ?? null);
  const downloadName = useLlmStore((s) => s.download?.modelId ?? null);
  const active = phase === 'starting' || phase === 'downloading';
  const elapsedMs = usePhaseElapsed(phase, active);

  const view = localStatusView({
    phase,
    loadedName: phase === 'ready' ? loadedName : null,
    pendingName: switchingTo ?? loadedName ?? downloadName,
    elapsedMs,
  });

  return (
    <div
      className="flex items-start gap-2 px-3 pb-2"
      data-testid="local-model-badge"
      data-dot={view.dot}
      title={view.detail ?? undefined}
    >
      <span
        aria-hidden
        className={`mt-[5px] size-[6px] shrink-0 rounded-full ${DOT_CLASS[view.dot]}`}
      />
      <div className="min-w-0">
        <div className="truncate text-footnote text-text-secondary" data-testid="local-headline">
          {view.headline}
        </div>
        {view.detail !== null ? (
          <div className="truncate text-caption text-text-muted" data-testid="local-detail">
            {view.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}
