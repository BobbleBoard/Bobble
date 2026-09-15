/**
 * Settings → Engines. One row per inference engine, install/remove in one click.
 *
 * the user: "an engine panel that allows downloading/uninstalling all available
 * engines 1 click. with a short blurb about what each is for and their disk size
 * (we'll only show things that are large enough to matter) we show everything
 * greyed out at bottom are unsupported."
 *
 * The rules about WHICH engines exist, what they are for and who can run them
 * live in engine-catalog.ts (pure, unit-tested). This file only draws them, so
 * the greying rule and onboarding's automatic pick can never drift apart.
 *
 * The one piece of judgement here: an unsupported row still shows its blurb and
 * size, greyed, rather than being hidden. Hiding it invites "why does the docs
 * page mention vLLM and my app doesn't"; showing it with "Linux only" answers
 * that without a support ticket.
 */
import { SegmentedControl, Spinner } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { EngineState } from '../../../electron/ipc-contract';
import { cx } from '../../onboarding/cx';
import { useLlmStore } from '../../state/llm-store';
import { useSettingsStore } from '../../state/settings-store';
import {
  ENGINES,
  type EngineSpec,
  formatEngineSize,
  type HostCapabilities,
  installPrerequisites,
  orderEnginesForDisplay,
  recommendedEngine,
} from '../engine-catalog';
import { hostGpuOf } from '../host-gpu';
import { SettingRow, SettingSection } from '../parts';

/** Bytes actually measured on disk beat the catalog's estimate once installed. */
function sizeLabel(spec: EngineSpec, state: EngineState | undefined): string | null {
  if (state?.installed === true && state.bytes !== undefined && state.bytes > 64 * 1024 * 1024) {
    const gb = state.bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(state.bytes / 1024 ** 2)} MB`;
  }
  return formatEngineSize(spec);
}

export function EnginePanel() {
  const [host, setHost] = useState<HostCapabilities | null>(null);
  const [states, setStates] = useState<Record<string, EngineState>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await window.piDesktop.invoke('engines:list', undefined).catch(() => null);
    if (res === null) return;
    setStates(Object.fromEntries(res.engines.map((e) => [e.id, e])));
  }, []);

  const hardware = useLlmStore((s) => s.hardware);
  useEffect(() => {
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((info) => {
        setHost({
          platform:
            info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
          appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
          gpu: hostGpuOf(hardware),
        });
      })
      .catch(() => setHost({ platform: 'linux', appleSilicon: false, gpu: hostGpuOf(hardware) }));
    void refresh();
  }, [refresh, hardware]);

  const act = async (id: string, kind: 'install' | 'uninstall') => {
    setPending(id);
    setError(null);
    const channel = kind === 'install' ? 'engines:install' : 'engines:uninstall';
    const res = await window.piDesktop.invoke(channel, { id }).catch(() => ({
      success: false,
      error: 'the request failed',
    }));
    if (!res.success) setError(res.error ?? `could not ${kind} ${id}`);
    await refresh();
    setPending(null);
  };

  if (host === null) {
    return (
      <div className="flex items-center gap-2 text-body text-text-muted">
        <Spinner size={16} /> Checking this machine…
      </div>
    );
  }

  const rows = orderEnginesForDisplay(host);
  const best = recommendedEngine(host);

  return (
    <div className="flex flex-col gap-4" data-testid="engine-panel">
      <p className="text-body text-text-secondary">
        Engines run your models. Bobble picks the best one for this machine, and you can add others
        for specific jobs: one for many agents at once, one for the fastest single chat.
      </p>

      <PowerSection />

      {error !== null ? (
        <p
          className="rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-primary"
          data-testid="engine-error"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {rows.map(({ spec, support }) => {
          const state = states[spec.id];
          const installed = state?.installed === true;
          const busy = pending === spec.id || state?.busy !== undefined;
          const size = sizeLabel(spec, state);
          const needs = installPrerequisites(spec.id).filter(
            (p) => states[p.id]?.installed !== true,
          );

          return (
            <div
              key={spec.id}
              data-testid={`engine-row-${spec.id}`}
              data-supported={support.supported ? 'yes' : 'no'}
              data-installed={installed ? 'yes' : 'no'}
              className={cx(
                'flex items-start gap-3 rounded-xl border border-border-default px-4 py-3',
                support.supported ? 'bg-bg-raised' : 'bg-bg-inset opacity-55',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body text-text-primary">{spec.name}</span>
                  {spec.id === best.id && support.supported ? (
                    <span
                      className="rounded-full border border-border-default px-2 py-0.5 text-footnote text-text-secondary"
                      data-testid="engine-recommended"
                    >
                      Recommended
                    </span>
                  ) : null}
                  {installed ? (
                    <span className="rounded-full bg-bg-active px-2 py-0.5 text-footnote text-text-primary">
                      Installed
                    </span>
                  ) : null}
                  {size !== null ? (
                    <span className="text-footnote text-text-muted">{size}</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-footnote text-text-secondary">{spec.blurb}</p>
                {spec.autoInstalls === true && !installed ? (
                  <p className="mt-1 text-footnote text-text-muted">
                    Installs itself with your first model.
                  </p>
                ) : null}
                {!support.supported ? (
                  <p className="mt-1 text-footnote text-text-muted" data-testid="engine-reason">
                    {support.reason}
                  </p>
                ) : needs.length > 0 && !installed ? (
                  <p className="mt-1 text-footnote text-text-muted">
                    Also installs {needs.map((n) => n.name).join(', ')}
                  </p>
                ) : null}
                {state?.error !== undefined ? (
                  <p className="mt-1 text-footnote text-text-muted">{state.error}</p>
                ) : null}
              </div>

              {support.supported && spec.autoInstalls === true && !installed ? (
                /* No button: this one installs itself when first needed, and an
                   Install control here would fail (see engines-main.ts). */
                <span
                  className="shrink-0 px-3 py-1.5 text-footnote text-text-muted"
                  data-testid={`engine-auto-${spec.id}`}
                >
                  Automatic
                </span>
              ) : support.supported ? (
                <button
                  type="button"
                  data-testid={`engine-action-${spec.id}`}
                  disabled={busy}
                  onClick={() => void act(spec.id, installed ? 'uninstall' : 'install')}
                  className={cx(
                    'shrink-0 rounded-lg border px-3 py-1.5 text-footnote transition-colors pd-focusable',
                    busy
                      ? 'cursor-default border-border-default text-text-muted'
                      : installed
                        ? 'border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        : 'border-transparent bg-accent-primary text-text-on-accent hover:opacity-90',
                  )}
                >
                  {busy ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner size={12} />
                      {state?.busy === 'removing' ? 'Removing' : 'Installing'}
                    </span>
                  ) : installed ? (
                    'Remove'
                  ) : (
                    'Install'
                  )}
                </button>
              ) : (
                <span className="shrink-0 px-3 py-1.5 text-footnote text-text-muted">
                  Unavailable
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-footnote text-text-muted">
        {ENGINES.length} engines known. Sizes are approximate until installed.
      </p>
    </div>
  );
}

/**
 * HOW HARD BOBBLE MAY PUSH THIS MACHINE.
 *
 * the user: "ensuring we leave a certain amount of memory available as a buffer so
 * the user can use computer as normal while generation and such occurs … this
 * could be dynamic even tracking what the current user memory/cpu/gpu usage is."
 *
 * Two controls, because there are two questions: WHEN to ease off (a mode) and
 * HOW MUCH to keep back (a number of gigabytes). The reserve is a number rather
 * than a percentage because that is how people think about it — "leave me 6 GB",
 * not "leave me 25%" of a total they would have to look up.
 *
 * What "ease off" does is deliberately NOT listed here: it depends on which wall
 * this particular machine is nearest, and the honest summary of that fits in the
 * hint. The full reasoning is in packages/inference/src/power-policy.ts.
 */
function PowerSection() {
  const mode = useSettingsStore((st) => st.settings.powerMode);
  const reserve = useSettingsStore((st) => st.settings.powerReserveGB);
  const update = useSettingsStore((st) => st.update);
  return (
    // Wrapped rather than passing a testid through SettingSection: that
    // component takes no DOM props, and widening it for one probe is a worse
    // trade than one span.
    <div data-testid="power-section">
      <SettingSection title="Power">
        <SettingRow
          label="While Bobble works"
          hint={
            mode === 'auto'
              ? 'Watches memory, CPU and (where the driver says) the GPU, and eases off only when this machine is actually struggling.'
              : mode === 'full'
                ? 'Never eases off. Fastest, and the machine may get sluggish while a model runs.'
                : 'Always eases off, even on an idle machine. Slower, and it stays out of your way.'
          }
        >
          <SegmentedControl
            aria-label="Power mode"
            data-testid="settings-power-mode"
            value={mode}
            onValueChange={(v) => void update({ powerMode: v as 'auto' | 'full' | 'low' })}
            options={[
              { value: 'auto', label: 'Adaptive' },
              { value: 'full', label: 'Full speed' },
              { value: 'low', label: 'Stay light' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Keep free for me"
          hint="Memory Bobble will not take, so your other apps keep theirs. Left alone it picks a sixth of this machine."
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
    </div>
  );
}
