/**
 * Settings → Experimental — the switches that change how hard Bobble may
 * lean on this machine, and the engines that are not the default yet.
 *
 * the user (2026-09-16): "implement into bobble extensive memory guards,
 * disable-able in settings under an experimental menu (place down here
 * alternative inference engine support by the way that's also experimental)."
 *
 * The memory guard's number lives here too: the reserve is the memory the
 * guard promises the rest of the Mac, and the whole point of the guard.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';
import { EnginePanel } from './EnginePanel';

export function ExperimentalPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const guard = settings.memoryGuard !== false;
  const reserve = settings.powerReserveGB;

  return (
    <div className="flex flex-col gap-8" data-testid="experimental-panel">
      <SettingSection
        title="Memory guard"
        description="Keeps this Mac responsive while Bobble works. Nothing heavy starts unless it fits beside the memory kept for you; anything running is paused the moment memory gets tight, resumes when it has come back, and is stopped if a pause is not enough."
        experimental
      >
        <SettingRow
          label="Guard memory"
          hint={
            guard
              ? 'On. Generations, 3D stages and a chat’s tools are paused in place when memory runs short — even mid-generation — and ended only if that does not bring it back.'
              : 'Off. Nothing is paused. Generations still wait for memory before starting and are stopped at the wall, as before the guard.'
          }
        >
          <SegmentedControl
            aria-label="Memory guard"
            data-testid="settings-memory-guard"
            value={guard ? 'on' : 'off'}
            onValueChange={(v) => void update({ memoryGuard: v === 'on' })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Keep free for me"
          hint="Memory Bobble will not take, so your other apps and the Mac itself keep theirs. Left alone it picks a sixth of this machine."
        >
          <input
            type="number"
            min={0}
            max={64}
            step={1}
            className="pd-input w-24"
            aria-label="Memory to keep free, in GB"
            data-testid="settings-power-reserve"
            value={reserve ?? ''}
            placeholder="auto"
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              // Blank / 0 means "you decide" — the same as never having set it.
              void update({ powerReserveGB: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Alternative inference engines"
        description="Engines other than the built-in llama.cpp. They can be faster for a given model or run several agents at once; they are also newer, and a wrong turn here is a chat that does not answer."
        experimental
      >
        <EnginePanel />
      </SettingSection>
    </div>
  );
}
