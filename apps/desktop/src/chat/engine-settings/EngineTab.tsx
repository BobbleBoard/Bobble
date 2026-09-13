/**
 * THE ENGINE TAB of the advanced panel: which engine's settings (llama.cpp
 * first, then whatever else is installed), three sub-tabs (Settings ·
 * Speculative · Command) and the running command line, with a PINNED footer
 * whose Apply restarts the server — greyed until something that needs a
 * restart has changed.
 *
 * "Needs a restart" is decided honestly: the supervisor stamps the fingerprint
 * of the user's flags + speculative choice it launched with on the status, and
 * the panel fingerprints its draft the same way. Different → Apply lights up;
 * the same → it does not, whatever was clicked on the way.
 */
import { configFingerprint } from '@pi-desktop/inference/engine-flags';
import { useEffect, useMemo, useState } from 'react';
import type {
  EngineLaunchConfig,
  ModelSpecChoice,
} from '../../../electron/settings/settings-contract';
import { ENGINES } from '../../settings/engine-catalog';
import { useLlmStore } from '../../state/llm-store';
import { useSettingsStore } from '../../state/settings-store';
import { CommandTab } from './CommandTab';
import { EngineFlagsTab } from './EngineFlagsTab';
import { emptyConfig, setFlag, shellJoin } from './engine-settings-logic';
import { CHAT_TEMPLATE_FLAG, type FlagSpec, type PathSource } from './FlagRow';
import { SpeculativeTab } from './SpeculativeTab';

type SubTab = 'settings' | 'speculative' | 'command' | 'running';

/** The engines the select offers: llama.cpp always, then the installed text engines. */
function engineChoices(
  engines: Record<string, { installed: boolean }>,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [{ id: 'llamacpp', name: 'llama.cpp' }];
  for (const e of ENGINES) {
    if (e.id === 'llamacpp' || !e.modalities.includes('text')) continue;
    if (engines[e.id]?.installed === true) out.push({ id: e.id, name: e.name });
  }
  return out;
}

export function EngineTab() {
  const status = useLlmStore((s) => s.status);
  const catalog = useLlmStore((s) => s.catalog);
  const engines = useLlmStore((s) => s.engines);
  const refreshEngines = useLlmStore((s) => s.refreshEngines);
  const engineFlags = useLlmStore((s) => s.engineFlags);
  const loadEngineFlags = useLlmStore((s) => s.loadEngineFlags);
  const relaunch = useLlmStore((s) => s.relaunch);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const runningEngine = status.profile?.engine ?? 'llamacpp';
  const [engine, setEngine] = useState(runningEngine);
  const [sub, setSub] = useState<SubTab>('settings');
  const [note, setNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const modelId = status.model?.id ?? null;
  const entry = useMemo(() => catalog.find((c) => c.id === modelId), [catalog, modelId]);

  // The draft the user edits, seeded from the saved settings.
  const [draft, setDraft] = useState<EngineLaunchConfig>(
    () => settings.engineLaunch[engine] ?? emptyConfig(),
  );
  const [spec, setSpec] = useState<ModelSpecChoice>(
    () => (modelId !== null ? settings.modelSpec[modelId] : undefined) ?? { method: 'auto' },
  );
  // Re-seed when the engine or the model changes under the panel.
  useEffect(() => {
    setDraft(settings.engineLaunch[engine] ?? emptyConfig());
  }, [engine, settings.engineLaunch]);
  useEffect(() => {
    setSpec((modelId !== null ? settings.modelSpec[modelId] : undefined) ?? { method: 'auto' });
  }, [modelId, settings.modelSpec]);

  useEffect(() => {
    void refreshEngines();
  }, [refreshEngines]);
  useEffect(() => {
    void loadEngineFlags(engine);
  }, [engine, loadEngineFlags]);

  const help = engineFlags[engine] ?? null;
  const choices = engineChoices(engines);

  /* Apply lights up when what the panel would launch with differs from what
     IS running — computed exactly as the supervisor computes its stamp. */
  const draftFingerprint = configFingerprint({
    engine: draft,
    spec: spec.method === 'auto' ? { method: 'auto' } : spec,
  });
  const runningHere = status.serverRunning && runningEngine === engine;
  const dirty = runningHere
    ? draftFingerprint !== (status.launchConfigFingerprint ?? '')
    : draftFingerprint !==
      configFingerprint({
        engine: settings.engineLaunch[engine] ?? emptyConfig(),
        spec: (modelId !== null ? settings.modelSpec[modelId] : undefined) ?? { method: 'auto' },
      });

  const save = async (): Promise<void> => {
    const patch: Parameters<typeof update>[0] = { engineLaunch: { [engine]: draft } };
    if (modelId !== null) patch.modelSpec = { [modelId]: spec };
    await update(patch);
  };

  const apply = async (): Promise<void> => {
    setApplying(true);
    setNote(null);
    try {
      await save();
      if (status.serverRunning) {
        const res = await relaunch();
        if (!res.success) setNote(res.error ?? 'the restart failed');
        else setNote('Restarted with the new settings.');
      } else {
        setNote('Saved — they apply when a model starts.');
      }
    } finally {
      setApplying(false);
    }
  };

  /* A path for a path-kind flag: the native picker filtered by what the flag
     is for, or a dropped file. A chat template is copied into Bobble's storage
     either way, so the launch line survives the original being moved. */
  const resolvePath = async (flag: FlagSpec, source: PathSource): Promise<string | null> => {
    const template = flag.key === CHAT_TEMPLATE_FLAG;
    let chosen: string | null;
    if (source.kind === 'drop') chosen = source.path;
    else {
      const kind = template
        ? 'chat-template'
        : /gguf/i.test(`${flag.placeholder ?? ''} ${flag.description}`)
          ? 'gguf'
          : /^(DIR|DIRECTORY|MODEL_DIR|PATH)$/i.test(flag.placeholder ?? '') &&
              /\b(dir|directory|folder)\b/i.test(flag.description)
            ? 'directory'
            : 'file';
      const r = await window.piDesktop
        .invoke('llm:pick-path', { kind })
        .catch(() => ({ path: null }));
      chosen = r.path;
    }
    if (chosen === null || !template) return chosen;
    const imported = await window.piDesktop
      .invoke('llm:import-chat-template', { path: chosen })
      .catch((err: unknown) => ({ path: chosen as string, error: String(err) }));
    if (imported.error !== undefined) setNote(`Could not copy the template: ${imported.error}`);
    else setNote('Template copied into Bobble’s storage.');
    return imported.path;
  };

  return (
    <div className="pd-engine-tab" data-testid="engine-settings-tab">
      <div className="pd-engine-tab-head">
        <label className="pd-engine-tab-select">
          <span className="pd-flags-group-title">Engine</span>
          <select
            className="pd-input pd-focusable"
            aria-label="Engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            data-testid="engine-settings-engine"
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.id === runningEngine && status.serverRunning ? ' · running' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="pd-engine-subtabs" role="tablist">
          {(
            [
              ['settings', 'Settings'],
              ['speculative', 'Speculative'],
              ['command', 'Paste a command'],
              ['running', 'Running now'],
            ] as const
          )
            .filter(([id]) => id !== 'speculative' || engine === 'llamacpp')
            .map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sub === id}
                className={`pd-engine-subtab${sub === id ? ' pd-engine-subtab--on' : ''}`}
                onClick={() => setSub(id)}
                data-testid={`engine-subtab-${id}`}
              >
                {label}
              </button>
            ))}
        </div>
      </div>

      <div className="pd-engine-tab-body">
        {sub === 'settings' ? (
          <EngineFlagsTab
            engine={engine}
            help={help}
            values={draft.flags}
            status={status}
            onChange={(k, v) => setDraft((d) => ({ ...d, flags: setFlag(d.flags, k, v) }))}
            onPath={resolvePath}
          />
        ) : sub === 'speculative' ? (
          <SpeculativeTab
            entry={entry}
            status={status}
            choice={spec}
            onChoice={setSpec}
            help={help}
            values={draft.flags}
            onFlag={(k, v) => setDraft((d) => ({ ...d, flags: setFlag(d.flags, k, v) }))}
            onPath={resolvePath}
          />
        ) : sub === 'command' ? (
          <CommandTab
            engine={engine}
            help={help}
            onAdd={(flags, raw) => {
              setDraft((d) => ({
                flags: { ...d.flags, ...flags },
                rawArgs: [...d.rawArgs, ...raw],
              }));
              setSub('settings');
            }}
          />
        ) : (
          <div className="pd-cmd" data-testid="running-tab">
            {status.launchCommand !== undefined && runningHere ? (
              <>
                <p className="pd-engine-row-sub">
                  The exact command line of the server that is up right now.
                </p>
                <pre className="pd-adv-well pd-scroll pd-cmd-running">
                  {shellJoin(status.launchCommand, status.launchArgs ?? [])}
                </pre>
              </>
            ) : (
              <p className="pd-engine-row-sub">
                {status.serverRunning
                  ? `The running server is ${runningEngine}, not ${engine}.`
                  : 'No server is running.'}
              </p>
            )}
            {draft.rawArgs.length > 0 ? (
              <div className="pd-cmd-raw">
                <span className="pd-flags-group-title">Raw arguments (passed as typed)</span>
                {draft.rawArgs.map((a, i) => (
                  // Raw tokens can repeat (`--flag v --flag v`); position is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: identical tokens at different positions are different arguments
                  <span key={`${i}:${a}`} className="pd-cmd-raw-chip">
                    <code>{a}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${a}`}
                      onClick={() =>
                        setDraft((d) => ({ ...d, rawArgs: d.rawArgs.filter((_, j) => j !== i) }))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="pd-engine-tab-foot" data-testid="engine-settings-footer">
        <span className="pd-engine-row-sub" data-testid="engine-settings-dirty">
          {note ??
            (dirty ? 'Changes need a restart to take effect.' : 'Running with these settings.')}
        </span>
        <div className="pd-engine-tab-foot-actions">
          <button
            type="button"
            className="pd-engine-install"
            onClick={() => {
              setDraft(emptyConfig());
              setSpec({ method: 'auto' });
            }}
            data-testid="engine-settings-reset"
          >
            Reset to Bobble defaults
          </button>
          <button
            type="button"
            className="pd-engine-calibrate"
            disabled={!dirty || applying}
            onClick={() => void apply()}
            data-testid="engine-settings-apply"
          >
            {applying ? 'Restarting…' : status.serverRunning ? 'Apply & restart' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
