/**
 * Settings › Quick panel — the floating panel a hotkey brings up over any app.
 *
 * On or off, a key for each thing it can do (recorded, checked against what
 * the Mac and common apps already use), whether the selected text comes along,
 * whether a click elsewhere puts it away, and the two permissions it needs —
 * each in plain words with the button that opens the right pane.
 */
import { Button, SegmentedControl } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_HOTKEYS,
  QUICK_ACTION_LABELS,
  QUICK_ACTIONS,
  type QuickAction,
} from '../../../electron/quick/hotkeys';
import type { QuickHotkeyStatus, QuickSystemPane } from '../../../electron/quick/quick-contract';
import { useSettingsStore } from '../../state/settings-store';
import { SettingGroup, SettingRow, SettingSection } from '../parts';
import { ShortcutRecorder } from '../ShortcutRecorder';

type Grant = 'granted' | 'denied' | 'unknown';

interface Status {
  readonly permissions: { screen: Grant; accessibility: Grant };
  readonly hotkeys: readonly QuickHotkeyStatus[];
}

/** The line under a key: whether it works, in words. */
function keyState(status: QuickHotkeyStatus | undefined): string | null {
  if (status === undefined) return null;
  switch (status.state) {
    case 'taken':
      return 'Another app is already using it. Pick another.';
    case 'blocked':
      return status.reason ?? 'That key cannot be used.';
    default:
      return null;
  }
}

const PERMISSIONS: ReadonlyArray<{
  key: 'screen' | 'accessibility';
  pane: QuickSystemPane;
  label: string;
  why: string;
}> = [
  {
    key: 'screen',
    pane: 'screen-recording',
    label: 'Screen Recording',
    why: 'To look at a window, an area or the whole screen when you ask about it.',
  },
  {
    key: 'accessibility',
    pane: 'accessibility',
    label: 'Accessibility',
    why: 'To read the text you have selected, put an answer back in its place, and use apps for you.',
  },
];

export function QuickPanelPanel() {
  const quick = useSettingsStore((s) => s.settings.quickPanel);
  const update = useSettingsStore((s) => s.update);
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(() => {
    void window.piDesktop
      .invoke('quick:status', undefined)
      .then((s) => setStatus({ permissions: s.permissions, hotkeys: s.hotkeys }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const setKey = (action: QuickAction, accelerator: string | null) => {
    void update({
      quickPanel: { ...quick, hotkeys: { ...quick.hotkeys, [action]: accelerator } },
    }).then(() => setTimeout(refresh, 100));
  };

  return (
    <div className="flex flex-col gap-8" data-testid="settings-quick-panel">
      <SettingSection description="Press a key in any app to ask Bobble about what you are doing: a window, an area of the screen, the text you selected, or something to do in that app. It works while Bobble's window is closed; quitting Bobble turns it off.">
        <SettingRow
          label="Quick panel"
          hint={
            quick.enabled
              ? 'On. The keys below work in every app.'
              : 'Off. No keys are taken from your other apps.'
          }
        >
          <SegmentedControl
            aria-label="Quick panel"
            data-testid="settings-quick-enabled"
            value={quick.enabled ? 'on' : 'off'}
            onValueChange={(v) => void update({ quickPanel: { ...quick, enabled: v === 'on' } })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Keys"
        description="Click a key to change it. Bobble checks it against what macOS and common apps already use."
      >
        <SettingGroup testId="settings-quick-keys">
          {QUICK_ACTIONS.map((action) => {
            const st = status?.hotkeys.find((h) => h.action === action);
            const problem = quick.enabled ? keyState(st) : null;
            const isDefault = quick.hotkeys[action] === DEFAULT_HOTKEYS[action];
            return (
              <div key={action} className="flex items-start justify-between gap-4">
                <div className="min-w-0 pt-1.5">
                  <div className="text-body text-text-primary">{QUICK_ACTION_LABELS[action]}</div>
                  {problem !== null ? (
                    <div
                      className="mt-0.5 text-footnote text-text-muted"
                      data-testid={`settings-quick-key-${action}-state`}
                    >
                      {problem}
                    </div>
                  ) : null}
                  {!isDefault && DEFAULT_HOTKEYS[action] !== null ? (
                    <button
                      type="button"
                      className="mt-0.5 text-footnote text-text-link"
                      onClick={() => setKey(action, DEFAULT_HOTKEYS[action])}
                    >
                      Use the default
                    </button>
                  ) : null}
                </div>
                <ShortcutRecorder
                  action={action}
                  value={quick.hotkeys[action]}
                  assigned={quick.hotkeys}
                  onChange={(accel) => setKey(action, accel)}
                  testid={`settings-quick-key-${action}`}
                />
              </div>
            );
          })}
        </SettingGroup>
      </SettingSection>

      <SettingSection title="Behaviour">
        <SettingRow
          label="Bring the selected text along"
          hint="When the panel opens, the text you have selected in the app in front comes with it, ready to explain, rewrite or translate. It is read on this Mac, never from a password field, and goes nowhere unless you ask."
        >
          <SegmentedControl
            aria-label="Bring the selected text along"
            data-testid="settings-quick-selection"
            value={quick.readSelection ? 'on' : 'off'}
            onValueChange={(v) =>
              void update({ quickPanel: { ...quick, readSelection: v === 'on' } })
            }
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Close when you click elsewhere" hint="A pinned panel always stays open.">
          <SegmentedControl
            aria-label="Close when you click elsewhere"
            data-testid="settings-quick-blur"
            value={quick.closeOnBlur ? 'on' : 'off'}
            onValueChange={(v) =>
              void update({ quickPanel: { ...quick, closeOnBlur: v === 'on' } })
            }
            options={[
              { value: 'on', label: 'Close' },
              { value: 'off', label: 'Stay open' },
            ]}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Permissions"
        description="macOS asks you to switch these on for Bobble yourself. Everything else works without them."
      >
        <SettingGroup testId="settings-quick-permissions">
          {PERMISSIONS.map((p) => {
            const grant = status?.permissions[p.key] ?? 'unknown';
            return (
              <div key={p.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-body text-text-primary">{p.label}</div>
                  <div className="mt-0.5 text-footnote text-text-muted">
                    {grant === 'granted' ? 'On. ' : grant === 'denied' ? 'Off. ' : ''}
                    {p.why}
                  </div>
                </div>
                {grant !== 'granted' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`settings-quick-open-${p.key}`}
                    onClick={() =>
                      void window.piDesktop.invoke('quick:open-system-settings', { pane: p.pane })
                    }
                  >
                    Open {p.label}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </SettingGroup>
      </SettingSection>
    </div>
  );
}
