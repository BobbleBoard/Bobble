/**
 * First-run onboarding wizard. Mounts before ChatApp on first run (App.tsx
 * gate), walks welcome → (import, when there is something to bring) → look →
 * how hands-on → get running, then applies the selected imports, persists the
 * choices and hands off to chat.
 *
 * THE PAGE HOLDS STILL (review 2026-10-09). Every step used to be centred
 * vertically, so the dots, the title and the buttons moved up and down from
 * page to page. The head is anchored to the top and the buttons to the
 * bottom; only the middle changes.
 */
import { Button, Spinner } from '@pi-desktop/ui';
import { useEffect, useMemo } from 'react';
import { cx } from './cx';
import { useFirstRunSetup } from './first-run-setup';
import {
  formatBytes,
  hasSomethingToImport,
  lookSubtitle,
  type OnboardingStepId,
  visibleSteps,
} from './onboarding-logic';
import { GetRunningStep, useGetRunningPlan } from './steps/GetRunningStep';
import { HandsOnStep } from './steps/HandsOnStep';
import { ImportStep } from './steps/ImportStep';
import { SourceStep } from './steps/SourceStep';
import { ThemeStep } from './steps/ThemeStep';
import { useOnboardingStore } from './useOnboarding';

const STEP_META: Record<OnboardingStepId, { title: string; subtitle: string }> = {
  welcome: {
    title: 'Welcome to Bobble',
    subtitle: 'Coming from another app? Bobble can carry your setup across.',
  },
  import: { title: 'Bring your setup', subtitle: 'Choose what to bring from your old app.' },
  look: { title: 'Make it yours', subtitle: '' },
  'hands-on': {
    title: 'How hands-on?',
    subtitle: 'How much Bobble asks before it acts. Change either answer anytime in Settings.',
  },
  'get-running': {
    title: 'Get running',
    subtitle:
      'The fastest engine for this Mac and a model to start with. They download in the background.',
  },
};

function StepBody({ step }: { step: OnboardingStepId }) {
  switch (step) {
    case 'welcome':
      return <SourceStep />;
    case 'import':
      return <ImportStep />;
    case 'look':
      return <ThemeStep />;
    case 'hands-on':
      return <HandsOnStep />;
    case 'get-running':
      return <GetRunningStep />;
    default:
      return null;
  }
}

/** The last page's buttons: download and finish, or skip. */
function GetRunningActions({ onComplete }: { onComplete: () => void }) {
  const ready = useGetRunningPlan();
  const finishing = useOnboardingStore((s) => s.finishing);
  const finish = useOnboardingStore((s) => s.finish);
  const start = useFirstRunSetup((s) => s.start);

  if (ready === null) {
    return (
      <Button variant="accent" disabled data-testid="onboarding-download-finish">
        Checking this Mac…
      </Button>
    );
  }
  if (ready.plan.totalBytes === 0 && ready.plan.engines.length === 0) {
    return (
      <Button
        variant="accent"
        data-testid="onboarding-finish"
        loading={finishing}
        onClick={() => void finish(onComplete)}
      >
        Finish
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {/* `onboarding-finish` is the one that downloads nothing: probes press it. */}
      <Button
        variant="ghost"
        data-testid="onboarding-finish"
        disabled={finishing}
        onClick={() => void finish(onComplete)}
      >
        Skip for now
      </Button>
      <Button
        variant="accent"
        data-testid="onboarding-download-finish"
        loading={finishing}
        onClick={() => {
          void start();
          void finish(onComplete);
        }}
      >
        Download and finish · {formatBytes(ready.plan.totalBytes)}
      </Button>
    </div>
  );
}

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const step = useOnboardingStore((s) => s.step);
  // A boolean, not s.steps(): a selector that builds a new array each call
  // never settles (zustand re-renders until the snapshot is stable).
  const withImport = useOnboardingStore((s) =>
    hasSomethingToImport(s.source, s.claude, s.codex, s.sessions.length),
  );
  const steps = useMemo(() => visibleSteps(withImport), [withImport]);
  const loading = useOnboardingStore((s) => s.loading);
  const finishing = useOnboardingStore((s) => s.finishing);
  const source = useOnboardingStore((s) => s.source);
  const canProceed = useOnboardingStore((s) => s.canProceed());
  const load = useOnboardingStore((s) => s.load);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);

  useEffect(() => {
    void load();
  }, [load]);

  const index = Math.max(0, steps.indexOf(step));
  const isLast = step === 'get-running';
  const meta = STEP_META[step];
  const subtitle = step === 'look' ? lookSubtitle(source) : meta.subtitle;

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="onboarding-wizard">
      {/* Draggable strip clearing the macOS traffic lights (frameless window). */}
      <div className="h-10 shrink-0 [-webkit-app-region:drag]" />

      {loading ? (
        <div
          className="flex flex-1 items-center justify-center gap-2 text-text-muted"
          data-testid="onboarding-loading"
        >
          <Spinner size={16} />
          <span className="text-footnote">Looking for your apps…</span>
        </div>
      ) : (
        <>
          {/* The gutter is kept even when nothing scrolls, so a tall page's
              scrollbar never nudges the column sideways. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]">
            <div className="mx-auto flex w-full max-w-[600px] flex-col pt-[7vh] pb-8">
              <div className="mb-8 flex items-center gap-3">
                <div className="flex items-center gap-1.5" aria-hidden>
                  {steps.map((id, i) => (
                    <span
                      key={id}
                      className={cx(
                        'h-1.5 rounded-full transition-all',
                        i === index
                          ? 'w-6 bg-accent-primary'
                          : i < index
                            ? 'w-1.5 bg-accent-primary'
                            : 'w-1.5 bg-border-strong',
                      )}
                    />
                  ))}
                </div>
                <span className="text-caption text-text-muted" data-testid="onboarding-step-label">
                  Step {index + 1} of {steps.length}
                </span>
              </div>

              <h1 className="pd-display-l text-text-primary">{meta.title}</h1>
              <p className="mt-2 mb-8 text-body text-text-muted">{subtitle}</p>

              {/* key restarts the enter animation each step (reduced-motion safe) */}
              <div key={step} className="pd-onboard-step">
                <StepBody step={step} />
              </div>
            </div>
          </div>

          <div className="shrink-0 border-border-subtle border-t px-6 py-4">
            <div className="mx-auto flex w-full max-w-[600px] items-center justify-between">
              <Button variant="ghost" onClick={back} disabled={index === 0 || finishing}>
                Back
              </Button>
              {isLast ? (
                <GetRunningActions onComplete={onComplete} />
              ) : (
                <Button
                  variant="accent"
                  data-testid="onboarding-next"
                  disabled={!canProceed}
                  onClick={next}
                >
                  Continue
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
