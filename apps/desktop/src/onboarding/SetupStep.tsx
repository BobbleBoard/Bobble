/**
 * Onboarding: get this machine ready to actually run something.
 *
 * the user: "at onboarding / initial setup we need to get 1. an optimal engine
 * initially, download the qwen3.5 4b checkpoint" and "add that harness swapping
 * mechanism… and add to onboarding".
 *
 * THE POINT IS THAT THE USER DOES NOT CHOOSE. Someone arriving at a local-AI app
 * has no basis to pick between llama.cpp and an MLX runtime, and asking them to
 * is how onboarding turns into homework. So this step SHOWS the decision already
 * made — the best engine for their hardware, the 4B checkpoint, the harness we
 * found — and lets them change it if they care. `recommendedEngine` is the same
 * function the Engines panel marks "Recommended" with, so the two surfaces can
 * never disagree about what the best choice is.
 *
 * Everything here is skippable. A download of several GB is not something to
 * hold a first run hostage to, and the app can start a model later from the
 * Models view; this step exists to make the common path one click, not to gate.
 */

import { sayIfRaw } from '@pi-desktop/shared';
import { Spinner } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { HarnessDetected } from '../../electron/ipc-contract';
import {
  formatEngineSize,
  type HostCapabilities,
  installPrerequisites,
  recommendedEngine,
} from '../settings/engine-catalog';
import { HARNESSES } from '../settings/harness-catalog';
import { cx } from './cx';

/** The checkpoint the user wants every fresh install to land with. */
const DEFAULT_MODEL_ID = 'qwen3.5-4b-mtp';

type Phase = 'idle' | 'working' | 'done' | 'failed';

export function SetupStep() {
  const [host, setHost] = useState<HostCapabilities | null>(null);
  const [enginePhase, setEnginePhase] = useState<Phase>('idle');
  const [modelPhase, setModelPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessDetected[]>([]);
  const [modelPresent, setModelPresent] = useState(false);

  useEffect(() => {
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((info) =>
        setHost({
          platform:
            info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
          appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
        }),
      )
      .catch(() => setHost({ platform: 'linux', appleSilicon: false }));

    // Which agents are already here — the same detection the Harness panel uses.
    const probes = HARNESSES.filter((h) => h.bin !== undefined).map((h) => ({
      id: h.id,
      bin: h.bin as string,
    }));
    void window.piDesktop
      .invoke('harness:detect', { probes })
      .then((r) => setHarnesses(r.found.filter((f) => f.installed)))
      .catch(() => undefined);

    // Don't offer to download something already on disk.
    void window.piDesktop
      .invoke('llm:get-status', undefined)
      .then((s) => setModelPresent(s.downloadedModelIds.includes(DEFAULT_MODEL_ID)))
      .catch(() => undefined);
  }, []);

  const engine = host === null ? null : recommendedEngine(host);

  const setUp = useCallback(async () => {
    if (engine === null) return;
    setError(null);

    // The engine first: a model with nothing to run it is a 4GB paperweight.
    // `autoInstalls` engines arrive with the model launch, so skip them here
    // rather than calling an installer that deliberately refuses.
    if (engine.autoInstalls !== true) {
      setEnginePhase('working');
      for (const dep of [...installPrerequisites(engine.id), engine]) {
        const res = await window.piDesktop
          .invoke('engines:install', { id: dep.id })
          .catch(() => ({ success: false, error: 'the request failed' }));
        if (!res.success) {
          setEnginePhase('failed');
          setError(res.error ?? `could not install ${dep.name}`);
          return;
        }
      }
    }
    setEnginePhase('done');

    if (!modelPresent) {
      setModelPhase('working');
      const res = await window.piDesktop
        .invoke('llm:download-model', { modelId: DEFAULT_MODEL_ID })
        .catch(() => ({ success: false, error: 'the download could not start' }));
      if (res.success !== true) {
        setModelPhase('failed');
        setError(res.error ?? 'the model download could not start');
        return;
      }
    }
    setModelPhase('done');
  }, [engine, modelPresent]);

  if (host === null || engine === null) {
    return (
      <div className="flex items-center gap-2 text-body text-text-muted">
        <Spinner size={16} /> Checking this machine…
      </div>
    );
  }

  const size = formatEngineSize(engine);
  const busy = enginePhase === 'working' || modelPhase === 'working';
  const ready = enginePhase === 'done' && modelPhase === 'done';

  const row = (label: string, detail: string, phase: Phase, testid: string) => (
    <div
      data-testid={testid}
      data-phase={phase}
      className="flex items-center gap-3 rounded-xl border border-border-default bg-bg-raised px-4 py-3"
    >
      <span
        className={cx(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-caption',
          phase === 'done'
            ? 'bg-accent-primary text-text-on-accent'
            : phase === 'failed'
              ? 'border border-border-strong text-text-muted'
              : 'border border-border-strong text-text-muted',
        )}
      >
        {phase === 'working' ? <Spinner size={11} /> : phase === 'done' ? '✓' : ''}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body text-text-primary">{label}</span>
        <span className="block text-footnote text-text-muted">{detail}</span>
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="onboarding-setup">
      {row(
        engine.name,
        engine.autoInstalls === true
          ? 'Arrives with your first model.'
          : `${engine.blurb}${size !== null ? ` · ${size}` : ''}`,
        engine.autoInstalls === true ? 'done' : enginePhase,
        'setup-engine',
      )}
      {row(
        'Qwen3.5 4B',
        modelPresent ? 'Already on this machine.' : 'The model Bobble starts you with.',
        modelPresent ? 'done' : modelPhase,
        'setup-model',
      )}
      {row(
        harnesses.length > 0
          ? `pi, plus ${harnesses.length} agent${harnesses.length === 1 ? '' : 's'} found`
          : 'pi (bundled)',
        harnesses.length > 0
          ? `Found ${harnesses.map((h) => h.id).join(', ')}. Connect them in Settings → Harness.`
          : 'Drives the chat, its tools and its subagents.',
        'done',
        'setup-harness',
      )}

      {error !== null ? (
        <p className="text-footnote text-text-muted" data-testid="setup-error">
          {sayIfRaw(error, 'install')} You can finish setup later from Settings.
        </p>
      ) : null}

      {!ready ? (
        <button
          type="button"
          data-testid="setup-start"
          disabled={busy}
          onClick={() => void setUp()}
          className={cx(
            'self-start rounded-lg px-3.5 py-2 text-body transition-opacity pd-focusable',
            busy
              ? 'bg-bg-active text-text-muted'
              : 'bg-accent-primary text-text-on-accent hover:opacity-90',
          )}
        >
          {busy ? 'Setting up…' : 'Set up now'}
        </button>
      ) : (
        <p className="text-footnote text-text-muted">
          Ready. The download continues in the background.
        </p>
      )}
    </div>
  );
}
