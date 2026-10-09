/**
 * Step — computer use. On or off, and when on, the apps Bobble may drive
 * without asking: a grid of the Mac's real app icons with names under them.
 *
 * The user (2026-09-15): "I would like a UI on onboarding for computer use on/off
 * and then if on choose what apps to allow control of, show this as a grid of
 * real app icons w/ names below, this is editable later in settings via a
 * similar UI." The grid is the same component Settings → Computer use draws.
 *
 * What the choice means is said on the step: an app ticked here is used
 * without the per-app question; any other app still asks first; off refuses
 * every Mac-driving action. Nothing here is a permission macOS grants — the
 * Accessibility / Screen Recording prompts come when Bobble first acts.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { AppGrid } from '../../computer-use/AppGrid';
import { useOnboardingStore } from '../useOnboarding';

export function ComputerUseStep() {
  const computerUse = useOnboardingStore((s) => s.computerUse);
  const setComputerUse = useOnboardingStore((s) => s.setComputerUse);

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-computer-use">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border-default bg-bg-raised p-4">
        <div className="min-w-0">
          <span className="block text-body font-medium text-text-primary">
            Let Bobble use your Mac
          </span>
          <span className="mt-0.5 block text-footnote text-text-muted">
            Bobble can click and type in apps for you, in the background, while you keep working.
            You can watch it and stop it at any time.
          </span>
        </div>
        <SegmentedControl
          aria-label="Computer use"
          data-testid="onboarding-computer-use-switch"
          value={computerUse.enabled ? 'on' : 'off'}
          onValueChange={(v) => setComputerUse({ ...computerUse, enabled: v === 'on' })}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body font-medium text-text-primary">
            Apps Bobble may use without asking
          </span>
        </div>
        <p className="text-footnote text-text-muted">
          Tick the apps you are happy for Bobble to drive. Any other app asks you first, each time.
          Change this later in Settings → Computer use.
        </p>
        <AppGrid
          selected={computerUse.apps}
          onChange={(apps) => setComputerUse({ ...computerUse, apps })}
          disabled={!computerUse.enabled}
          size="lg"
          maxHeight="min(46vh, 440px)"
          testid="onboarding-app-grid"
        />
      </div>
    </div>
  );
}
