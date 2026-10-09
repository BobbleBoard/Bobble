/**
 * THE FIRST MODEL, ONE CLICK FROM THE EMPTY CHAT.
 *
 * Review 2026-10-09: a fresh Mac whose person pressed "Skip for now" landed on
 * an empty chat with a "Getting started" popover over the sidebar, and the
 * first message was then held with "There is no model on this Mac". This card
 * replaces both: while the Mac has no chat model it sits above the input with
 * the one download that fixes that (the engine for this Mac and the 4B), and
 * it becomes the progress once that download is running — whether it was
 * started here or by onboarding's "Download and finish" (one store,
 * first-run-setup.ts). It goes away when the model is on the Mac.
 *
 * Same card as a generation module's Download (`.pd-module-card`), so the two
 * read as one kind of thing.
 */
import { sayIfRaw } from '@pi-desktop/shared';
import { useEffect } from 'react';
import {
  START_MODEL_ID,
  START_MODEL_NAME,
  setupPlan,
  useFirstRunSetup,
  useNoModelYet,
} from '../onboarding/first-run-setup';
import { formatBytes } from '../onboarding/onboarding-logic';
import { installPrerequisites } from '../settings/engine-catalog';
import { useLlmStore } from '../state/llm-store';

export function FirstModelCard() {
  const check = useFirstRunSetup((s) => s.check);
  const start = useFirstRunSetup((s) => s.start);
  const engine = useFirstRunSetup((s) => s.engine);
  const installed = useFirstRunSetup((s) => s.installedEngineIds);
  const enginePhase = useFirstRunSetup((s) => s.enginePhase);
  const engineError = useFirstRunSetup((s) => s.engineError);
  const noModel = useNoModelYet();
  const download = useLlmStore((s) => (s.download?.modelId === START_MODEL_ID ? s.download : null));
  const downloadError = useLlmStore((s) =>
    s.downloadError?.modelId === START_MODEL_ID ? s.downloadError.error : null,
  );
  const modelBytes = useLlmStore(
    (s) => s.catalog.find((m) => m.id === START_MODEL_ID)?.quants[0]?.bytes ?? 0,
  );
  const resume = useLlmStore((s) => s.resumeDownload);

  useEffect(() => {
    void check();
  }, [check]);

  const engineWorking = enginePhase === 'working';
  if (!noModel && download === null && !engineWorking) return null;

  const plan =
    engine === null
      ? null
      : setupPlan({
          engine,
          prerequisites: installPrerequisites(engine.id),
          installedEngineIds: installed,
          modelBytes,
          modelPresent: false,
        });

  let title: string;
  let sub: string;
  let percent: number | undefined;
  let busy = false;
  let action: { label: string; run: () => void; testid: string } | null = null;

  if (engineWorking) {
    busy = true;
    title = 'Getting the engine for this Mac…';
    sub = `${engine?.name ?? 'The engine'}, then ${START_MODEL_NAME}. Nothing to do meanwhile.`;
  } else if (download?.paused) {
    title = `${START_MODEL_NAME} is paused`;
    sub = progressLine(download.received, download.total ?? modelBytes);
    percent = download.fraction !== null ? Math.round(download.fraction * 100) : undefined;
    action = { label: 'Resume', run: () => void resume(), testid: 'first-model-resume' };
  } else if (download !== null) {
    busy = true;
    title = `Downloading ${START_MODEL_NAME}…`;
    sub = progressLine(download.received, download.total ?? modelBytes);
    percent = download.fraction !== null ? Math.round(download.fraction * 100) : undefined;
  } else if (downloadError !== null || enginePhase === 'failed') {
    title = downloadError !== null ? 'The download stopped' : 'The engine did not install';
    sub = sayIfRaw(downloadError ?? engineError ?? 'it did not finish', 'install');
    action = { label: 'Try again', run: () => void start(), testid: 'first-model-retry' };
  } else {
    title = 'Download a model to start';
    const size =
      plan !== null && plan.totalBytes > 0 ? ` ${formatBytes(plan.totalBytes)}, once.` : '';
    sub = `${START_MODEL_NAME} answers right here on this Mac, with the fastest engine for it.${size}`;
    action = { label: 'Download', run: () => void start(), testid: 'first-model-download' };
  }

  return (
    <div className="pd-module-notice">
      <section
        className="pd-module-card"
        data-testid="first-model-card"
        data-installing={busy ? 'true' : 'false'}
        aria-live="polite"
      >
        <div className="pd-module-card-main">
          <p className="pd-module-card-title">{title}</p>
          <p className="pd-module-card-sub">{sub}</p>
          {busy || percent !== undefined ? (
            <div
              className="pd-module-card-track"
              data-indeterminate={percent === undefined ? 'true' : 'false'}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
            >
              <div
                className="pd-module-card-fill"
                style={percent !== undefined ? { width: `${percent}%` } : undefined}
              />
            </div>
          ) : null}
        </div>
        {action !== null ? (
          <div className="pd-module-card-actions">
            <button
              type="button"
              className="pd-module-card-btn"
              onClick={action.run}
              data-testid={action.testid}
            >
              {action.label}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function progressLine(received: number, total: number): string {
  if (total <= 0) return formatBytes(received);
  return `${formatBytes(received)} of ${formatBytes(total)}`;
}
