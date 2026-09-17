/**
 * Appearance settings: the theme mode (light/dark/system), applied live and
 * persisted, and — new — CODE APPEARANCE: a code theme for each mode with a
 * live preview under each picker, and a custom monospace font for code and
 * the terminal. The claude/codex flavor toggle lives in Interface → Advanced
 * (round-5 #23) so this view stays about what a person sees every day.
 *
 * the user: "in terminal in the canvas in dark mode there's a dark red color
 * that's a bit unreadable, for the color coding please add a list of text
 * coloring styles as claude does … there's separate settings and a little
 * preview in the appearance settings menu." The reference is Claude's
 * desktop app: two dropdowns side by side, a searchable list in each, a diff
 * preview under each, then a code-font field.
 */
import { resolveCodeTheme } from '@pi-desktop/code-themes';
import { Input, SegmentedControl } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';
import { CodeThemePicker } from './code-theme/CodeThemePicker';
import { CodeThemePreview } from './code-theme/CodeThemePreview';

/** How long a pause in typing a font name is before it is saved. */
const FONT_SAVE_DELAY_MS = 350;

function CodeFontField() {
  const codeFont = useSettingsStore((s) => s.settings.codeFont);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(codeFont);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A change from elsewhere (a reload, a reset) shows in the field.
  useEffect(() => {
    setDraft(codeFont);
  }, [codeFont]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (value: string): void => {
    clearTimeout(timer.current);
    if (value.trim() !== codeFont) void update({ codeFont: value.trim() });
  };

  return (
    <Input
      type="text"
      data-testid="settings-code-font"
      aria-label="Code font"
      placeholder="e.g. JetBrains Mono"
      spellCheck={false}
      autoComplete="off"
      className="pd-code-font-input"
      value={draft}
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        // Applied as you type, after a beat: the fences and the terminal
        // change font while the name is still being finished.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(value), FONT_SAVE_DELAY_MS);
      }}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(draft);
      }}
    />
  );
}

export function AppearancePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const light = resolveCodeTheme(settings.codeTheme.light, 'light');
  const dark = resolveCodeTheme(settings.codeTheme.dark, 'dark');

  return (
    <div className="flex flex-col gap-8">
      <SettingSection description="Choose light, dark, or match your system.">
        <SettingRow label="Mode" hint="System follows your macOS appearance setting.">
          <SegmentedControl
            aria-label="Theme mode"
            data-testid="settings-mode"
            value={settings.theme.mode}
            onValueChange={(v) =>
              void update({
                theme: { mode: v === 'light' ? 'light' : v === 'dark' ? 'dark' : 'system' },
              })
            }
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Code appearance"
        description="How code reads in replies, on the canvas and in the terminal. One theme for each mode; the app's own mode decides which is in use."
      >
        <div
          className="pd-setting-row flex flex-col rounded-lg border border-border-default bg-bg-raised p-4"
          data-testid="settings-code-theme"
        >
          <div className="pd-code-theme-grid">
            <div className="pd-code-theme-column">
              <span className="text-body font-medium text-text-primary">Light theme</span>
              <span className="mt-0.5 text-footnote text-text-muted">
                Used while the app is light.
              </span>
              <div className="mt-3 flex flex-col gap-3">
                <CodeThemePicker
                  mode="light"
                  value={light}
                  label="Light code theme"
                  testId="code-theme-light"
                  onChange={(id) => void update({ codeTheme: { light: id } })}
                />
                <CodeThemePreview theme={light} testId="code-theme-preview-light" />
              </div>
            </div>
            <div className="pd-code-theme-column">
              <span className="text-body font-medium text-text-primary">Dark theme</span>
              <span className="mt-0.5 text-footnote text-text-muted">
                Used while the app is dark.
              </span>
              <div className="mt-3 flex flex-col gap-3">
                <CodeThemePicker
                  mode="dark"
                  value={dark}
                  label="Dark code theme"
                  testId="code-theme-dark"
                  onChange={(id) => void update({ codeTheme: { dark: id } })}
                />
                <CodeThemePreview theme={dark} testId="code-theme-preview-dark" />
              </div>
            </div>
          </div>
        </div>

        <SettingRow
          label="Code font"
          hint="Set a custom monospace font for code and the terminal. Leave empty for the system's."
        >
          <CodeFontField />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
