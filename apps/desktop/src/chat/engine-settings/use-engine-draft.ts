/**
 * THE DRAFT the Advanced panel edits — which engine, its flags, the shared
 * knobs, the speculative choice — and whether applying it needs a restart.
 * Lifted out of the Engine tab so the Flags tab edits the same draft and the
 * dialog header's Reset / Apply act on it from any tab.
 *
 * "Needs a restart" is decided honestly: the supervisor stamps the fingerprint
 * of the user's flags + speculative choice it launched with on the status, and
 * the panel fingerprints its draft the same way. Different → Apply lights up;
 * the same → it does not, whatever was clicked on the way.
 */
import { configFingerprint } from '@pi-desktop/inference/engine-flags';
import { effectiveLaunchConfig } from '@pi-desktop/inference/portable-knobs';
import { useEffect, useMemo, useState } from 'react';
import type {
  EngineFlagValue,
  EngineLaunchConfig,
  ModelSpecChoice,
} from '../../../electron/settings/settings-contract';
import { ENGINES } from '../../settings/engine-catalog';
import { useLlmStore } from '../../state/llm-store';
import { useSettingsStore } from '../../state/settings-store';
import { emptyConfig, setFlag } from './engine-settings-logic';
import { CHAT_TEMPLATE_FLAG, type FlagSpec, type PathSource } from './FlagRow';

/** The engines the select offers: llama.cpp always, then the installed text engines. */
export function engineChoices(
  engines: Record<string, { installed: boolean }>,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [{ id: 'llamacpp', name: 'llama.cpp' }];
  for (const e of ENGINES) {
    if (e.id === 'llamacpp' || !e.modalities.includes('text')) continue;
    if (engines[e.id]?.installed === true) out.push({ id: e.id, name: e.name });
  }
  return out;
}

export function useEngineDraft() {
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
  const [note, setNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const modelId = status.model?.id ?? null;
  const entry = useMemo(() => catalog.find((c) => c.id === modelId), [catalog, modelId]);

  const [draft, setDraft] = useState<EngineLaunchConfig>(
    () => settings.engineLaunch[engine] ?? emptyConfig(),
  );
  const [spec, setSpec] = useState<ModelSpecChoice>(
    () => (modelId !== null ? settings.modelSpec[modelId] : undefined) ?? { method: 'auto' },
  );
  // The cross-engine knobs, drafted alongside; '' marks a knob being cleared.
  const [knobs, setKnobs] = useState<Record<string, EngineFlagValue>>(
    () => settings.portableKnobs ?? {},
  );
  useEffect(() => {
    setDraft(settings.engineLaunch[engine] ?? emptyConfig());
  }, [engine, settings.engineLaunch]);
  useEffect(() => {
    setKnobs(settings.portableKnobs ?? {});
  }, [settings.portableKnobs]);
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

  const cleanKnobs = Object.fromEntries(Object.entries(knobs).filter(([, v]) => v !== ''));
  const draftFingerprint = configFingerprint({
    engine: effectiveLaunchConfig(engine, {
      knobs: cleanKnobs,
      engineLaunch: { ...settings.engineLaunch, [engine]: draft },
    }),
    spec: spec.method === 'auto' ? { method: 'auto' } : spec,
  });
  const runningHere = status.serverRunning && runningEngine === engine;
  const dirty = runningHere
    ? draftFingerprint !== (status.launchConfigFingerprint ?? '')
    : draftFingerprint !==
      configFingerprint({
        engine: effectiveLaunchConfig(engine, {
          knobs: settings.portableKnobs ?? {},
          engineLaunch: settings.engineLaunch,
        }),
        spec: (modelId !== null ? settings.modelSpec[modelId] : undefined) ?? { method: 'auto' },
      });

  const save = async (): Promise<void> => {
    const patch: Parameters<typeof update>[0] = {
      engineLaunch: { [engine]: draft },
      portableKnobs: knobs,
    };
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
        setNote(
          res.success ? 'Restarted with the new settings.' : (res.error ?? 'the restart failed'),
        );
      } else {
        setNote('Saved — they apply when a model starts.');
      }
    } finally {
      setApplying(false);
    }
  };

  const reset = (): void => {
    setDraft(emptyConfig());
    setSpec({ method: 'auto' });
    setKnobs(Object.fromEntries(Object.keys(knobs).map((k) => [k, ''])));
    setNote(null);
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

  /** The engine's own default for a flag (from its --help), by any spelling. */
  const defaultFor = (flagNames: readonly string[]): string | undefined => {
    for (const f of help?.flags ?? []) {
      if (flagNames.includes(f.key) || f.aliases.some((a) => flagNames.includes(a))) {
        return f.defaultValue;
      }
    }
    return undefined;
  };

  return {
    status,
    entry,
    engine,
    setEngine,
    choices,
    runningEngine,
    runningHere,
    help,
    draft,
    setDraft,
    setFlagValue: (k: string, v: EngineFlagValue | null) =>
      setDraft((d) => ({ ...d, flags: setFlag(d.flags, k, v) })),
    spec,
    setSpec,
    knobs,
    cleanKnobs,
    setKnob: (id: string, v: EngineFlagValue | null) =>
      setKnobs((k) => ({ ...k, [id]: v === null ? '' : v })),
    engineLaunch: { ...settings.engineLaunch, [engine]: draft },
    dirty,
    applying,
    note,
    apply,
    reset,
    resolvePath,
    defaultFor,
  };
}

export type EngineDraft = ReturnType<typeof useEngineDraft>;
