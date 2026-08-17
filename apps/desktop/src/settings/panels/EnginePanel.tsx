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
import { Spinner } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { EngineState } from '../../../electron/ipc-contract';
import { cx } from '../../onboarding/cx';
import {
  ENGINES,
  type EngineSpec,
  formatEngineSize,
  type HostCapabilities,
  installPrerequisites,
  orderEnginesForDisplay,
  recommendedEngine,
} from '../engine-catalog';

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

  useEffect(() => {
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((info) => {
        setHost({
          platform:
            info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
          appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
        });
      })
      .catch(() => setHost({ platform: 'linux', appleSilicon: false }));
    void refresh();
  }, [refresh]);

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
        for specific jobs — one for many agents at once, one for the fastest single chat.
      </p>

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
