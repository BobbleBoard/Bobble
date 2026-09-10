/**
 * UI customization (round-5 #23). The main section keeps the everyday chrome
 * knob (global icon stroke width → `--pd-icon-stroke` on the document root,
 * persisted as `iconStroke`). An ADVANCED section below holds the nitpicky
 * customization: the claude/codex theme FLAVOR toggle (relocated out of the main
 * Appearance view) and a developer entry into the component GALLERY (relocated
 * off the top bar). Default icon stroke is the token value (1.25).
 */
import { Button, IconStrokeControl, SegmentedControl } from '@pi-desktop/ui';
import { useSettingsStore } from '../../state/settings-store';
import { SettingGroup, SettingRow, SettingSection, SettingSlider } from '../parts';

export function InterfacePanel({
  onOpenGallery,
  onRedoOnboarding,
}: {
  onOpenGallery?: () => void;
  onRedoOnboarding?: () => void;
}) {
  const iconStroke = useSettingsStore((s) => s.settings.iconStroke);
  const sidebarScale = useSettingsStore((s) => s.settings.sidebarScale);
  const menuScale = useSettingsStore((s) => s.settings.menuScale);
  const flavor = useSettingsStore((s) => s.settings.theme.flavor);
  const _productionHarness = useSettingsStore((s) => s.settings.experimentalProductionHarness);
  const generation = useSettingsStore((s) => s.settings.experimentalGeneration);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="flex flex-col gap-8">
      <SettingSection description="Fine-tune how the app's chrome looks.">
        <SettingRow
          label="Icon thickness"
          hint="How heavy the line icons throughout the app appear. Lighter reads calmer."
        >
          <IconStrokeControl
            data-testid="settings-icon-stroke"
            value={iconStroke}
            onChange={(v) => void update({ iconStroke: v })}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Element size"
        description="Scale individual parts of the app up or down. 1.00× is the default."
      >
        {/* The two scale knobs and the icon-thickness one above them are the
            same kind of control, so they are now drawn by the same part — the
            readout used to sit AFTER the track here and ABOVE it there. */}
        <SettingGroup>
          <SettingSlider
            label="Sidebar size"
            hint="Scale the sidebar's rows, icons and text."
            min={0.8}
            max={1.5}
            step={0.05}
            value={sidebarScale}
            testId="settings-sidebar-scale"
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => void update({ sidebarScale: v })}
            action={
              sidebarScale !== 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="settings-sidebar-scale-reset"
                  onClick={() => void update({ sidebarScale: 1 })}
                >
                  Reset
                </Button>
              ) : null
            }
          />
          <SettingSlider
            label="Menu size"
            hint="Scale dropdown menu options (the model picker and the + menu)."
            min={0.8}
            max={1.5}
            step={0.05}
            value={menuScale}
            testId="settings-menu-scale"
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => void update({ menuScale: v })}
            action={
              menuScale !== 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="settings-menu-scale-reset"
                  onClick={() => void update({ menuScale: 1 })}
                >
                  Reset
                </Button>
              ) : null
            }
          />
        </SettingGroup>
      </SettingSection>

      <SettingSection title="Advanced" description="Deeper customization and developer tools.">
        <SettingRow
          label="Theme flavor"
          hint="Bobble is the native look; Claude and Codex match those apps."
        >
          <SegmentedControl
            aria-label="Theme flavor"
            data-testid="settings-flavor"
            value={flavor}
            onValueChange={(v) =>
              void update({
                theme: { flavor: v === 'codex' ? 'codex' : v === 'claude' ? 'claude' : 'bobble' },
              })
            }
            options={[
              { value: 'bobble', label: 'Bobble' },
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ]}
          />
        </SettingRow>

        {onRedoOnboarding !== undefined ? (
          <SettingRow
            label="Redo onboarding"
            hint="Replay the first-run setup wizard (imports, theme, experience). Your settings are kept."
          >
            <div>
              <Button
                variant="outline"
                size="sm"
                data-testid="settings-redo-onboarding"
                onClick={onRedoOnboarding}
              >
                Redo onboarding
              </Button>
            </div>
          </SettingRow>
        ) : null}

        {onOpenGallery !== undefined ? (
          <SettingRow
            label="Component gallery (dev)"
            hint="Browse the design-system component spec book."
          >
            <div>
              <Button
                variant="outline"
                size="sm"
                data-testid="settings-open-gallery"
                onClick={onOpenGallery}
              >
                Open component gallery
              </Button>
            </div>
          </SettingRow>
        ) : null}
      </SettingSection>

      <SettingSection
        title="Experimental"
        description="Early features, still being built. Off by default."
      >
        {/*
         * "Coordination harness" REMOVED. the user: deprecated. It only ever took
         * effect alongside the `?corpForce` dev URL param
         * (productionHarnessEnabled && corpForceEnabled in ChatComposer), so as a
         * user-facing switch it did nothing — the corporation is reached through
         * the top effort levels now. The dev override is untouched.
         */}
        <SettingRow
          label="On-device generation"
          hint="Give the assistant on-device image/video generation tools (Apple-Silicon MLX/mflux; ComfyUI for video) that stream results onto the canvas. Downloads models on first use. Restart to apply. Experimental."
        >
          <SegmentedControl
            aria-label="On-device generation"
            data-testid="settings-experimental-generation"
            value={generation ? 'on' : 'off'}
            onValueChange={(v) => void update({ experimentalGeneration: v === 'on' })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
