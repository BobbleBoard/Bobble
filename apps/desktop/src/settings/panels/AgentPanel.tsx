/**
 * Agent settings: default permission mode + effort + the classifier preset. The
 * permission/effort segments drive the frozen harness through its `/harness`
 * slash commands (settings-store applies them); the preset picker sends
 * `/harness preset <x>` directly (pi-connect) and reflects the harness's live
 * active task class. The descriptions mirror what each level actually changes.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { EffortLevel, PermissionMode } from '../../../electron/settings/settings-contract';
import { classLabel, useHarnessStatus } from '../../chat/harness-status';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

const PERMISSION_HINT: Record<PermissionMode, string> = {
  bypass: 'Runs every tool call without review. Fastest, least safe.',
  reviewer:
    'Flags risky shell commands before they run, using regex rules plus a small model when one is loaded.',
  'review-all': 'Approve every tool call yourself.',
};

const EFFORT_HINT: Record<EffortLevel, string> = {
  low: 'Fewest repair passes. Fastest replies.',
  medium: 'Balanced repair + one self-review pass.',
  high: 'More repair attempts, extra review, adversarial checks.',
  max: 'Most reliability passes. Slowest.',
};

export function AgentPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingSection
      title="Agent"
      description="How much oversight and effort the agent applies. Takes effect in the current session."
    >
      <SettingRow label="Permissions" hint={PERMISSION_HINT[settings.permissionMode]}>
        <SegmentedControl
          aria-label="Permission mode"
          data-testid="settings-permission"
          value={settings.permissionMode}
          onValueChange={(v) => void update({ permissionMode: v as PermissionMode })}
          options={[
            { value: 'bypass', label: 'Bypass' },
            { value: 'reviewer', label: 'Reviewer' },
            { value: 'review-all', label: 'Review all' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Effort" hint={EFFORT_HINT[settings.effort]}>
        <SegmentedControl
          aria-label="Effort level"
          data-testid="settings-effort"
          value={settings.effort}
          onValueChange={(v) => void update({ effort: v as EffortLevel })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
          ]}
        />
      </SettingRow>

      {/*
       * "Task preset" REMOVED. the user: "task classification set hard? not needed".
       * The classifier picks a toolset per task and does it well; a pin was a way
       * to make it worse by hand, and it duplicated a decision the harness
       * already owns. The underlying `/harness preset` route is untouched for
       * anything that drives it directly.
       */}
    </SettingSection>
  );
}
