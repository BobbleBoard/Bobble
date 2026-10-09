/**
 * Step 3 — auto-theme. Flavor + mode were preset from the source app; both are
 * swappable here and apply live to the whole app (the theme store drives the
 * data-flavor/data-mode attributes on <html>).
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { useThemeStore } from '../../store/theme';

export function ThemeStep() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const setFlavor = useThemeStore((s) => s.setFlavor);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-footnote text-text-muted">Appearance</span>
        <SegmentedControl
          aria-label="Theme flavor"
          value={flavor}
          onValueChange={(v) =>
            setFlavor(v === 'codex' ? 'codex' : v === 'claude' ? 'claude' : 'bobble')
          }
          options={[
            { value: 'bobble', label: 'Bobble' },
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-footnote text-text-muted">Mode</span>
        <SegmentedControl
          aria-label="Theme mode"
          value={mode}
          onValueChange={(v) => setMode(v === 'light' ? 'light' : 'dark')}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </div>

      <p className="text-footnote text-text-muted" data-testid="theme-preview">
        The whole app is already wearing it. Change it anytime from Settings → Appearance.
      </p>
    </div>
  );
}
