/**
 * UI customization (round-5 #23). The everyday chrome knobs: the icons'
 * THICKNESS (`--pd-icon-stroke`, pixels, persisted as `iconStroke`) and a
 * SIZE panel — the icons' own scale (`--pd-icon-scale`, `iconScale`) beside
 * the sidebar and menu scales. An ADVANCED section below holds the nitpicky
 * customization: the theme FLAVOR toggle and a developer entry into the
 * component GALLERY. Default icon stroke is the token value (1.25).
 *
 * the user (2026-09-20): "add to the interface slider a more realistic range of
 * stroke thickness none of which look absolutely excessive … also add to that
 * interface settings area a 'size' panel, and remove from experimental the
 * 'on device generation' button, that's just a bit silly, the whole app is
 * that". The generation toggle is gone; generation is simply on.
 */
import { Button, IconStrokeControl, SegmentedControl } from '@pi-desktop/ui';
import { ICON_SCALE_MAX, ICON_SCALE_MIN } from '../../../electron/settings/settings-contract';
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
  const iconScale = useSettingsStore((s) => s.settings.iconScale);
  const sidebarScale = useSettingsStore((s) => s.settings.sidebarScale);
  const menuScale = useSettingsStore((s) => s.settings.menuScale);
  const flavor = useSettingsStore((s) => s.settings.theme.flavor);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="flex flex-col gap-8">
      <SettingSection description="Fine-tune how the app's chrome looks.">
        <SettingRow
          label="Icon thickness"
          hint="How heavy the line icons throughout the app appear, in pixels. Lighter reads calmer; the range stops where the drawings would clog."
        >
          <IconStrokeControl
            data-testid="settings-icon-stroke"
            value={iconStroke}
            onChange={(v) => void update({ iconStroke: v })}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Size"
        description="Scale parts of the app up or down. 1.00× is the default."
      >
        {/* The scale knobs and the icon-thickness one above them are the same
            kind of control, so they are drawn by the same part. */}
        <SettingGroup>
          <SettingSlider
            label="Icon size"
            hint="Every icon in the app, from its own size. Rows and toolbars keep their spacing."
            min={ICON_SCALE_MIN}
            max={ICON_SCALE_MAX}
            step={0.05}
            value={iconScale}
            testId="settings-icon-scale"
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => void update({ iconScale: v })}
            action={
              iconScale !== 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="settings-icon-scale-reset"
                  onClick={() => void update({ iconScale: 1 })}
                >
                  Reset
                </Button>
              ) : null
            }
          />
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
    </div>
  );
}
