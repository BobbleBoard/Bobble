/**
 * Settings → Computer use: the same choice onboarding makes, editable.
 *
 * The user (2026-09-15): "… this is editable later in settings via a similar UI."
 * On/off, the grid of real app icons (the apps Bobble may drive without
 * asking — anything else asks first, each time), and the status pill toggle
 * that used to sit under Agent, because it is about the same thing.
 *
 * The policy is read by the consent gate on every action (mac-agent's
 * `policy` bridge method), so a change here applies to the next click, not
 * the next session.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { AppGrid } from '../../computer-use/AppGrid';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

export function ComputerUsePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const cu = settings.computerUse;

  return (
    <SettingSection description="Bobble can click and type in apps for you, in the background, while you keep working. You can watch it in the Computer use tab and stop it at any time.">
      <SettingRow
        label="Let Bobble use your Mac"
        hint={
          cu.enabled
            ? 'On. Apps ticked below are used without asking; any other app asks you first, each time.'
            : 'Off. Every request to click or type in an app is refused until this is on.'
        }
      >
        <SegmentedControl
          aria-label="Computer use"
          data-testid="settings-computer-use"
          value={cu.enabled ? 'on' : 'off'}
          onValueChange={(v) => void update({ computerUse: { ...cu, enabled: v === 'on' } })}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </SettingRow>

      <SettingRow
        label="Apps Bobble may use without asking"
        hint="Tick an app to skip the question for it. Bobble itself, Keychain Access and System Settings can never be driven."
      >
        <AppGrid
          selected={cu.apps}
          onChange={(apps) => void update({ computerUse: { ...cu, apps } })}
          disabled={!cu.enabled}
          testid="settings-app-grid"
        />
      </SettingRow>

      <SettingRow
        label="Show computer use status pill"
        hint="The small label beside the phantom cursor while the agent drives an app. Turning it off leaves the cursor — you still see where it is acting, just without words over your windows."
      >
        <SegmentedControl
          aria-label="Show computer use status pill"
          data-testid="settings-status-pill"
          value={settings.showComputerUseStatusPill === false ? 'off' : 'on'}
          onValueChange={(v) => void update({ showComputerUseStatusPill: v === 'on' })}
          options={[
            { value: 'on', label: 'Show' },
            { value: 'off', label: 'Hide' },
          ]}
        />
      </SettingRow>
    </SettingSection>
  );
}
