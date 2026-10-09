/**
 * Get running — the last page. It SHOWS the decision already made (the
 * fastest engine for this Mac, the 4B) rather than asking for one, then the
 * generation switches beside the model they come with.
 *
 * The page's buttons are the wizard's footer ("Download and finish" with the
 * real size, and "Skip for now"); `useGetRunningPlan` is what both read. What
 * the old page said wrong (review 2026-10-09): engine jargon ("MLX DFlash ·
 * around 1.4-1.6x · its drafter arrives with the model"), status circles that
 * read as unticked options, a second model recommended on the page before,
 * and "installs happen later" without saying when.
 */
import {
  Checkbox,
  IconCamera,
  IconCheck,
  IconDownload,
  IconImage,
  IconMic,
  IconPuzzle,
  Spinner,
} from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { GenerationCapabilities } from '../../../electron/import/import-contract';
import { type EngineSpec, installPrerequisites } from '../../settings/engine-catalog';
import { HARNESSES } from '../../settings/harness-catalog';
import { useLlmStore } from '../../state/llm-store';
import { cx } from '../cx';
import {
  type SetupPlan,
  START_MODEL_ID,
  START_MODEL_NAME,
  setupPlan,
  useFirstRunSetup,
} from '../first-run-setup';
import { formatBytes } from '../onboarding-logic';
import { useOnboardingStore } from '../useOnboarding';

export interface GetRunningPlan {
  readonly engine: EngineSpec;
  readonly engineInstalled: boolean;
  readonly modelPresent: boolean;
  readonly plan: SetupPlan;
}

/** The engine, the model and what downloading them costs; null until this Mac is checked. */
export function useGetRunningPlan(): GetRunningPlan | null {
  const checked = useFirstRunSetup((s) => s.checked);
  const engine = useFirstRunSetup((s) => s.engine);
  const installed = useFirstRunSetup((s) => s.installedEngineIds);
  const entry = useLlmStore((s) => s.catalog.find((m) => m.id === START_MODEL_ID));
  const onDisk = useLlmStore((s) => s.status.downloadedModelIds.includes(START_MODEL_ID));
  if (!checked || engine === null) return null;
  const modelPresent = onDisk || entry?.downloaded === true;
  const plan = setupPlan({
    engine,
    prerequisites: installPrerequisites(engine.id),
    installedEngineIds: installed,
    modelBytes: entry?.quants[0]?.bytes ?? 0,
    modelPresent,
  });
  return {
    engine,
    engineInstalled: engine.autoInstalls !== true && plan.engines.length === 0,
    modelPresent,
    plan,
  };
}

const CAPS: Array<{ key: keyof GenerationCapabilities; title: string; icon: ReactNode }> = [
  { key: 'image', title: 'Pictures', icon: <IconImage /> },
  { key: 'video', title: 'Video', icon: <IconCamera /> },
  { key: 'audio', title: 'Speech and sound', icon: <IconMic /> },
  { key: 'threeD', title: '3D models', icon: <IconPuzzle /> },
];

function Row({
  done,
  title,
  detail,
  testid,
}: {
  done: boolean;
  title: string;
  detail: string;
  testid: string;
}) {
  return (
    <div data-testid={testid} data-phase={done ? 'done' : 'to-download'} className="flex gap-3">
      {/* A glyph for what will happen, not an empty circle that reads as an
          option left unticked. */}
      <span
        aria-hidden
        className={cx(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          done ? 'bg-accent-subtle text-accent-primary' : 'bg-bg-inset text-text-secondary',
        )}
      >
        {done ? <IconCheck size={14} /> : <IconDownload size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body text-text-primary">{title}</span>
        <span className="block text-footnote text-text-muted">{detail}</span>
      </span>
    </div>
  );
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function GetRunningStep() {
  const ready = useGetRunningPlan();
  const harnesses = useFirstRunSetup((s) => s.harnesses);
  const capabilities = useOnboardingStore((s) => s.capabilities);
  const toggleCapability = useOnboardingStore((s) => s.toggleCapability);

  if (ready === null) {
    return (
      <div
        className="flex items-center gap-2 text-body text-text-muted"
        data-testid="onboarding-setup"
      >
        <Spinner size={16} /> Checking this Mac…
      </div>
    );
  }

  const { engine, engineInstalled, modelPresent, plan } = ready;
  const engineDetail =
    engine.autoInstalls === true
      ? `${engine.name}, which comes with the model`
      : engineInstalled
        ? `${engine.name}, already installed`
        : `${engine.name} · ${formatBytes(plan.engineBytes)}`;
  // Other agents only: a pi found on the PATH is Bobble's own agent again.
  const agentNames = harnesses
    .filter((h) => !h.id.startsWith('pi-'))
    .map((h) => HARNESSES.find((c) => c.id === h.id)?.name ?? h.id);

  return (
    <div className="flex flex-col gap-8" data-testid="onboarding-setup">
      <section className="flex flex-col gap-4">
        <Row
          testid="setup-engine"
          done={engine.autoInstalls === true || engineInstalled}
          title="The fastest engine for this Mac"
          detail={engineDetail}
        />
        <Row
          testid="setup-model"
          done={modelPresent}
          title={START_MODEL_NAME}
          detail={
            modelPresent
              ? 'Already on this Mac'
              : `The model Bobble starts you with · ${formatBytes(plan.modelBytes)}`
          }
        />
        {agentNames.length > 0 ? (
          <p className="text-footnote text-text-muted" data-testid="setup-harness">
            Also on this Mac: {listNames(agentNames)}. Bobble can hand a chat to{' '}
            {agentNames.length === 1 ? 'it' : 'either'} from Settings{'\u00a0'}→{'\u00a0'}Harness.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-body font-medium text-text-primary">Also make</h2>
          <p className="text-footnote text-text-muted">
            Each one downloads the first time you use it, not now.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {CAPS.map((cap) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (custom control)
            <label key={cap.key} className="flex cursor-pointer items-center gap-3">
              <Checkbox
                checked={capabilities[cap.key]}
                onCheckedChange={() => toggleCapability(cap.key)}
                data-testid={`capability-${cap.key}`}
              />
              <span aria-hidden className="text-text-secondary">
                {cap.icon}
              </span>
              <span className="text-body text-text-primary">{cap.title}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
