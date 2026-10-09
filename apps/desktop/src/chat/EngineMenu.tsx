/**
 * THE ENGINE MENU — a small speedometer right of the chat's name.
 *
 * The user: "at the top bar, to the right of the chat name, show a little icon,
 * clicking this has a dropdown that shows a little scrollable list of the
 * inference engines with a 'calibrate' button at the top, during generation
 * this should also live show tps numbers. clicking calibrate pauses anything
 * running in the current chat, then runs the calibration and swaps to the
 * proper engine and speculative method."
 *
 * Three things live in the dropdown, top to bottom:
 *
 *   1. CALIBRATE — the button, and while it runs, the rows filling in one by
 *      one (decode and prefill tok/s per engine × method, or why one failed).
 *      A chat mid-reply is paused first (the composer's own Pause, so the reply
 *      stays resumable) because the server it is talking to is about to be
 *      swapped out under it.
 *   2. WHAT IS RUNNING — the model, the engine and the method it came up on,
 *      and the tok/s: live while a reply streams, the last reply's when not.
 *   3. THE ENGINES — every text engine the catalogue knows for this machine,
 *      in the same order as Settings → Engines, with what it would cost to
 *      install one and a click to do it; unsupported rows say why.
 *
 * Every row that was measured is clickable: it relaunches the model on that
 * engine + method by hand, calibration's verdict notwithstanding.
 */

import { sayIfRaw } from '@pi-desktop/shared';
import { Glyph, IconButton, Popover, PopoverContent, PopoverTrigger, Switch } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { EngineState, LlmCompanion } from '../../electron/ipc-contract';
import {
  ENGINES,
  type EngineSpec,
  engineSupport,
  formatEngineSize,
  type HostCapabilities,
  orderEnginesForDisplay,
} from '../settings/engine-catalog';
import { hostGpuOf } from '../settings/host-gpu';
import { type CalibrationView, useLlmStore } from '../state/llm-store';
import { pausePi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useSettingsStore } from '../state/settings-store';

/** How the menu names an engine id (matches the catalogue where it has a row). */
function engineName(id: string): string {
  if (id === 'rapid-mlx-vision') return "rapid-mlx's vision runtime";
  return ENGINES.find((e) => e.id === id)?.name ?? id;
}

const SPEC_LABEL: Record<string, string> = {
  none: 'plain',
  mtp: 'MTP',
  eagle3: 'EAGLE-3',
  dflash: 'DFlash',
  dspark: 'DSpark',
  ngram: 'n-gram',
  auto: 'auto',
};

function specLabel(spec: string): string {
  return SPEC_LABEL[spec] ?? spec;
}

function tps(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/** The compact readout beside the icon: only while a reply is streaming. */
function LiveReadout() {
  const live = useLlmStore((s) => s.live);
  const streaming = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  if (live === null || live.done || !streaming || live.tps <= 0) return null;
  return (
    <span className="pd-engine-live" data-testid="engine-live-tps" aria-live="off">
      {tps(live.tps)} tok/s
    </span>
  );
}

function ThroughputLine() {
  const live = useLlmStore((s) => s.live);
  const metrics = useLlmStore((s) => s.status.metrics);
  const streaming = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  if (live !== null && !live.done && streaming && live.tps > 0) {
    return (
      <span className="pd-engine-tps pd-engine-tps--live" data-testid="engine-menu-tps">
        <span className="pd-engine-tps-dot" aria-hidden />≈ {tps(live.tps)} tok/s · {live.tokens}{' '}
        tokens so far
      </span>
    );
  }
  if (live?.done && live.tps > 0) {
    return (
      <span className="pd-engine-tps" data-testid="engine-menu-tps">
        last reply {tps(live.tps)} tok/s
        {metrics?.avgTps !== undefined ? ` · avg ${tps(metrics.avgTps)}` : ''}
      </span>
    );
  }
  // A zero here is a warm-up's timings, not a speed; say nothing rather than "0.0".
  if (metrics?.lastTps !== undefined && metrics.lastTps > 0) {
    return (
      <span className="pd-engine-tps" data-testid="engine-menu-tps">
        {tps(metrics.lastTps)} tok/s
        {metrics.avgTps !== undefined && metrics.avgTps > 0 ? ` · avg ${tps(metrics.avgTps)}` : ''}
      </span>
    );
  }
  // Nothing to say until there is a number — the user: the user knows the tok/s
  // shows up; a line announcing that it will is noise.
  return null;
}

/** One measured (or measuring, or failed) candidate row. */
function CandidateRow({
  id,
  label,
  view,
  active,
  chosen,
  onUse,
}: {
  id: string;
  label: string;
  view: CalibrationView['rows'][string] | undefined;
  active: boolean;
  chosen: boolean;
  onUse: () => void;
}) {
  const done = view?.state === 'done' ? view : null;
  const usable = done?.ok === true;
  return (
    <button
      type="button"
      className="pd-engine-row pd-engine-row--candidate"
      data-testid={`calib-row-${id.replace('/', '-')}`}
      data-state={view?.state ?? 'pending'}
      data-ok={done === null ? undefined : done.ok ? 'yes' : 'no'}
      disabled={!usable}
      onClick={onUse}
      title={usable ? 'Run the model this way' : undefined}
    >
      <span className="pd-engine-row-main">
        <span className="pd-engine-row-name">
          {label}
          {chosen ? <span className="pd-engine-chip pd-engine-chip--chosen">chosen</span> : null}
          {active && !chosen ? <span className="pd-engine-chip">running</span> : null}
        </span>
        {done !== null && !done.ok ? (
          <span className="pd-engine-row-sub pd-engine-row-sub--error">
            {sayIfRaw(done.error, 'engine')}
          </span>
        ) : null}
      </span>
      <span className="pd-engine-row-side">
        {view === undefined ? (
          <span className="pd-engine-row-sub">queued</span>
        ) : view.state === 'starting' ? (
          <span className="pd-engine-row-sub">starting…</span>
        ) : view.state === 'measuring' ? (
          <span className="pd-engine-row-sub">measuring…</span>
        ) : done?.ok ? (
          <span className="pd-engine-nums">
            <b>{tps(done.decodeTps)}</b> tok/s
            <span className="pd-engine-nums-dim"> · prefill {tps(done.prefillTps)}</span>
          </span>
        ) : (
          <span className="pd-engine-row-sub pd-engine-row-sub--error">did not run</span>
        )}
      </span>
    </button>
  );
}

/** One skip of the live plan, as the menu draws it. */
type PlanSkip = {
  id: string;
  engine: string;
  spec: string;
  label: string;
  reason: string;
  fix: 'fetch' | 'install' | 'none';
};

function CalibrationSection({
  onUse,
  plan,
}: {
  onUse: (engine: string, spec: string) => void;
  /** The live plan's skips (what a calibration would skip NOW), or null while unknown. */
  plan: PlanSkip[] | null;
}) {
  const calibration = useLlmStore((s) => s.calibration);
  const record = useLlmStore((s) => s.record);
  const profile = useLlmStore((s) => s.status.profile);

  // What to draw: a live run beats the stored verdict; the stored verdict beats nothing.
  const rows = useMemo(() => {
    if (calibration !== null && (calibration.running || calibration.record === null)) {
      return {
        source: 'live' as const,
        list: calibration.candidates.map((c) => ({
          id: c.id,
          engine: c.engine,
          spec: c.spec,
          label: c.label,
          view: calibration.rows[c.id],
        })),
        skips: calibration.skips.map((k) => ({
          ...k,
          fix: ((k as { fix?: string }).fix ?? 'none') as PlanSkip['fix'],
        })),
        chosen: calibration.chosen,
        error: calibration.error,
      };
    }
    const rec = calibration?.record ?? record;
    if (rec === null) return null;
    return {
      source: 'record' as const,
      list: rec.ranked.map((r) => ({
        id: r.id,
        engine: r.engine,
        spec: r.spec,
        label: `${engineName(r.engine)} · ${specLabel(r.spec)}`,
        view: {
          state: 'done' as const,
          ok: r.ok,
          ...(r.error !== undefined ? { error: r.error } : {}),
          decodeTps: r.decodeTps,
          prefillTps: r.prefillTps,
          ttftMs: r.ttftMs,
          startupMs: r.startupMs,
        },
      })),
      /* A stored record's skips describe the disk as it WAS: the twin that was
         fetched since would still read "not downloaded". The live plan is what
         a calibration would skip now, so that is what the list says. */
      skips:
        plan ??
        rec.skips.map((k) => ({
          ...k,
          label: `${engineName(k.engine)} · ${specLabel(k.spec)}`,
          fix: (k.fix ?? 'none') as PlanSkip['fix'],
        })),
      chosen: rec.chosen,
      error: null,
      at: rec.at,
    };
  }, [calibration, record, plan]);

  if (rows === null) return null;
  return (
    <div className="pd-engine-section" data-testid="engine-calibration">
      <div className="pd-engine-section-title">
        {rows.source === 'live'
          ? calibration?.running
            ? `Calibrating · ${Math.min(calibration.index + 1, calibration.total)} of ${calibration.total}`
            : rows.error !== null
              ? `Calibration ${rows.error === 'cancelled' ? 'cancelled' : 'failed'}`
              : 'Calibration'
          : `Calibrated ${new Date(rows.at ?? 0).toLocaleDateString()}`}
      </div>
      {rows.error !== null && rows.error !== 'cancelled' ? (
        <div
          className="pd-engine-row-sub pd-engine-row-sub--error"
          data-testid="engine-calibration-error"
        >
          {sayIfRaw(rows.error, 'engine')}
        </div>
      ) : null}
      {rows.list.map((r) => (
        <CandidateRow
          key={r.id}
          id={r.id}
          label={r.label}
          view={r.view}
          active={profile !== undefined && profile.engine === r.engine && profile.spec === r.spec}
          chosen={
            rows.chosen !== null && rows.chosen.engine === r.engine && rows.chosen.spec === r.spec
          }
          onUse={() => onUse(r.engine, r.spec)}
        />
      ))}
      {rows.skips.length > 0 ? (
        <details className="pd-engine-skips">
          <summary>{rows.skips.length} not measured</summary>
          {rows.skips.map((k) => (
            <div
              key={k.id}
              className="pd-engine-skip"
              data-testid={`calib-skip-${k.id.replace('/', '-')}`}
              data-fix={k.fix}
            >
              <span>{k.label}</span>
              <span className="pd-engine-row-sub">{k.reason}</span>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

/**
 * MAKE EVERYTHING MEASURABLE — one little button under Calibrate.
 *
 * The user (2026-09-13): "we need the 'not measured' engines to all be measurable
 * by clicking a single button to install everything they need to measure
 * them, for all recommended models." So the button counts BOTH kinds of
 * missing thing for the running model: the engines this machine could install
 * but has not (the live plan's `install` skips) and the twins/drafters the
 * catalogue names that are not on disk (`llm:companions`). One press installs
 * the engines one after another, then starts the model's own download job
 * for the files (the GGUF is skipped as present; the extras come down on the
 * top-bar bar). A row nothing can fix — no drafter published, an engine this
 * Mac cannot run — is listed with that reason and not counted.
 *
 * Re-asked whenever the menu opens and whenever a download or an install
 * settles, so the count is the disk's truth and not a stored record's.
 */
export function FetchMissingButton({
  open,
  plan,
  onNote,
}: {
  open: boolean;
  plan: PlanSkip[] | null;
  onNote: (text: string | null) => void;
}) {
  const model = useLlmStore((s) => s.status.model);
  const download = useLlmStore((s) => s.download);
  const downloadModel = useLlmStore((s) => s.downloadModel);
  const installEngine = useLlmStore((s) => s.installEngine);
  const engines = useLlmStore((s) => s.engines);
  const [missing, setMissing] = useState<LlmCompanion[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const modelId = model?.id ?? null;
  const quant = model?.quant;
  const fetching = download !== null && modelId !== null && download.modelId === modelId;
  const anyInstalling = Object.values(engines).some((e) => e.busy === 'installing');
  /* `installing` too: rapid-mlx's vision runtime is not an engine the store
     lists, so `anyInstalling` never moves for it — without this the count
     held it as missing after it landed, and a second press reinstalled it. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fetching`, `anyInstalling` and `installing` ARE triggers — the answer changes when any settles
  useEffect(() => {
    if (!open || modelId === null) {
      setMissing([]);
      return;
    }
    let live = true;
    void window.piDesktop
      .invoke('llm:companions', quant === undefined ? { modelId } : { modelId, quant })
      .then((r) => {
        if (live) setMissing(r.companions.filter((c) => !c.present));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, modelId, quant, fetching, anyInstalling, installing]);
  if (modelId === null) return null;
  /* An `engine:<id>` companion is something to INSTALL (rapid-mlx's vision
     runtime), not a file to download with the model. */
  const runtimes = missing
    .filter((c) => c.kind.startsWith('engine:'))
    .map((c) => c.kind.slice('engine:'.length));
  const files = missing.filter((c) => !c.kind.startsWith('engine:'));
  const toInstall = [
    ...new Set([
      ...(plan ?? []).filter((k) => k.fix === 'install').map((k) => k.engine),
      ...runtimes,
    ]),
  ];
  const count = files.length + toInstall.length;
  const busy = fetching || installing !== null;
  const nothing = count === 0 && !busy;
  const what = [
    ...toInstall.map((e) => `install ${engineName(e)}`),
    ...files.map((c) => c.what),
  ].join(', ');
  const run = async (): Promise<void> => {
    onNote(null);
    for (const e of toInstall) {
      setInstalling(e);
      const r = await installEngine(e);
      if (!r.success) onNote(r.error ?? `could not install ${engineName(e)}`);
    }
    setInstalling(null);
    if (files.length > 0) await downloadModel(modelId, quant);
  };
  return (
    <button
      type="button"
      className="pd-engine-install pd-engine-fetch"
      data-testid="engine-fetch-missing"
      data-missing={count}
      disabled={busy || nothing}
      title={
        installing !== null
          ? `Installing ${engineName(installing)}…`
          : fetching
            ? 'Fetching…'
            : nothing
              ? 'Every engine this Mac can run is installed, and every twin and drafter the catalogue names for this model is on disk'
              : `Will ${what}`
      }
      onClick={() => void run()}
    >
      {installing !== null
        ? `Installing ${engineName(installing)}…`
        : fetching
          ? 'Fetching…'
          : nothing
            ? 'Nothing missing'
            : `Fetch missing · ${count}`}
    </button>
  );
}

function EngineRow({
  spec,
  host,
  state,
  active,
  onInstall,
}: {
  spec: EngineSpec;
  host: HostCapabilities;
  state: EngineState | undefined;
  active: boolean;
  onInstall: () => void;
}) {
  const support = engineSupport(spec, host);
  const installed = state?.installed === true;
  const busy = state?.busy;
  const size = formatEngineSize(spec);
  return (
    <div
      className="pd-engine-row"
      data-testid={`engine-menu-row-${spec.id}`}
      data-supported={support.supported ? 'yes' : 'no'}
      data-installed={installed ? 'yes' : 'no'}
      data-active={active ? 'yes' : 'no'}
    >
      <span className="pd-engine-row-main">
        <span className="pd-engine-row-name">
          {spec.name}
          {active ? <span className="pd-engine-chip pd-engine-chip--chosen">running</span> : null}
        </span>
        <span className="pd-engine-row-sub">{support.supported ? spec.blurb : support.reason}</span>
        {state?.error !== undefined ? (
          <span className="pd-engine-row-sub pd-engine-row-sub--error">
            {sayIfRaw(state.error, 'install')}
          </span>
        ) : null}
      </span>
      <span className="pd-engine-row-side">
        {!support.supported ? null : busy !== undefined ? (
          <span className="pd-engine-row-sub">
            {busy === 'installing' ? 'installing…' : 'removing…'}
          </span>
        ) : installed ? (
          <span className="pd-engine-chip pd-engine-chip--ok">installed</span>
        ) : spec.autoInstalls === true ? (
          <span className="pd-engine-row-sub">on first use</span>
        ) : (
          <button
            type="button"
            className="pd-engine-install"
            data-testid={`engine-menu-install-${spec.id}`}
            onClick={onInstall}
          >
            Install{size !== null ? ` · ${size}` : ''}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * VISION — ON UNLESS SAID OTHERWISE.
 *
 * The user (2026-09-23): "mmproj/vision should always be loaded and usable by
 * default unless explicitly turned off, put this in the engines option and
 * leave a setting to not load vision by default." The switch is the setting;
 * the line under it is what is TRUE of the running server — it reads images,
 * or which engine took the launch so it could, or exactly why it cannot. A
 * change relaunches the model (the projector / lane is a launch argument), and
 * a reply in flight is paused first so it can be resumed.
 */
export function VisionRow({ onNote }: { onNote: (text: string | null) => void }) {
  const loadVision = useSettingsStore((s) => s.settings.loadVision !== false);
  const update = useSettingsStore((s) => s.update);
  const relaunch = useLlmStore((s) => s.relaunch);
  const status = useLlmStore((s) => s.status);
  const busyTurn = usePiStore((s) => s.agent.isStreaming || s.promptInFlight || s.resuming);
  const [switching, setSwitching] = useState(false);
  const sees = status.visionReady === true;
  const line = !status.serverRunning
    ? loadVision
      ? 'On — the next model loads with its vision.'
      : 'Off — models load text-only.'
    : sees
      ? status.visionFallback !== undefined
        ? `Reads images — on llama.cpp, because ${status.visionFallback.why}.`
        : status.profile?.engine === 'rapid-mlx'
          ? "Reads images — rapid-mlx's vision lane (no MTP there)."
          : 'Reads images — screenshots, pictures, pages.'
      : status.blindReason === 'off'
        ? 'Off — text-only. An image a tool takes is described as unseen.'
        : status.blindReason === 'model'
          ? 'This model has no vision.'
          : status.blindReason === 'engine'
            ? 'This engine is text-only — images are described as unseen.'
            : status.blindReason === 'projector'
              ? 'The vision projector could not be loaded.'
              : 'Cannot read images right now.';
  const onChange = async (on: boolean): Promise<void> => {
    onNote(null);
    setSwitching(true);
    try {
      await update({ loadVision: on });
      /* A model still LOADING took the old setting with it, and is not
         running yet — so it is relaunched too (the supervisor waits for the
         load to land); saved only, it came up the other way round. */
      if (status.serverRunning || status.phase === 'starting') {
        if (busyTurn) await pausePi();
        const r = await relaunch();
        if (!r.success) onNote(r.error ?? 'could not relaunch the model');
      }
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div
      className="pd-engine-vision"
      data-testid="engine-vision"
      data-on={loadVision ? 'yes' : 'no'}
      data-sees={sees ? 'yes' : 'no'}
    >
      <span className="pd-engine-vision-text">
        <span className="pd-engine-row-name">Vision</span>
        <span className="pd-engine-row-sub" data-testid="engine-vision-line">
          {switching ? 'Relaunching…' : line}
        </span>
      </span>
      <Switch
        size="sm"
        checked={loadVision}
        disabled={switching}
        aria-label="Load vision"
        data-testid="engine-vision-switch"
        onCheckedChange={(v) => void onChange(v)}
      />
    </div>
  );
}

export function EngineMenu() {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HostCapabilities | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const status = useLlmStore((s) => s.status);
  const engines = useLlmStore((s) => s.engines);
  const calibration = useLlmStore((s) => s.calibration);
  const record = useLlmStore((s) => s.record);
  const refreshEngines = useLlmStore((s) => s.refreshEngines);
  const refreshRecord = useLlmStore((s) => s.refreshRecord);
  const calibrate = useLlmStore((s) => s.calibrate);
  const cancelCalibration = useLlmStore((s) => s.cancelCalibration);
  const installEngine = useLlmStore((s) => s.installEngine);
  const switchProfile = useLlmStore((s) => s.switchProfile);
  const busyTurn = usePiStore((s) => s.agent.isStreaming || s.promptInFlight || s.resuming);

  const hardware = useLlmStore((s) => s.hardware);
  useEffect(() => {
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((info) =>
        setHost({
          platform:
            info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
          appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
          gpu: hostGpuOf(hardware),
        }),
      )
      .catch(() => setHost({ platform: 'linux', appleSilicon: false, gpu: hostGpuOf(hardware) }));
  }, [hardware]);

  // Fresh disk truth every time the menu opens, and every 2 s while something installs.
  const anyBusy = Object.values(engines).some((e) => e.busy !== undefined);
  useEffect(() => {
    if (!open) return;
    void refreshEngines();
    void refreshRecord();
    if (!anyBusy) return;
    const t = setInterval(() => void refreshEngines(), 2000);
    return () => clearInterval(t);
  }, [open, anyBusy, refreshEngines, refreshRecord]);

  const rows = useMemo(
    () =>
      host === null
        ? []
        : orderEnginesForDisplay(host).filter(({ spec }) => spec.modalities.includes('text')),
    [host],
  );

  const running = calibration?.running === true;
  const model = status.model;

  /* The live plan: what a calibration would measure now and what stands in
     the way of the rest — fetched when the menu opens and again whenever a
     download or an install settles, so a stored verdict's stale "not
     downloaded" never outlives the download. Engines this host could install
     are the renderer's knowledge (the engine catalogue), sent along. */
  const [plan, setPlan] = useState<PlanSkip[] | null>(null);
  const download = useLlmStore((s) => s.download);
  const installableKey = rows
    .filter(({ spec, support }) => support.supported && engines[spec.id]?.installed !== true)
    .map(({ spec }) => spec.id)
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a settled download or install changes the answer
  useEffect(() => {
    if (!open || model === null || model === undefined) {
      setPlan(null);
      return;
    }
    let live = true;
    void window.piDesktop
      .invoke('llm:calibration-plan', {
        modelId: model.id,
        ...(model.quant === undefined ? {} : { quant: model.quant }),
        installableEngines: installableKey === '' ? [] : installableKey.split(','),
      })
      .then((r) => {
        if (live) setPlan(r.skips);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, model?.id, model?.quant, installableKey, download === null, anyBusy, running]);
  const canCalibrate =
    model !== null && model !== undefined && status.phase === 'ready' && !running;

  const onCalibrate = async () => {
    setNote(null);
    // The server this turn is streaming from is about to be swapped out: pause
    // the reply first so it stays resumable rather than dying mid-sentence.
    if (busyTurn) {
      await pausePi();
      setNote('Paused your reply — press ▶ in the composer to continue when calibration is done.');
    }
    const res = await calibrate();
    if (!res.ok && res.error !== undefined && res.error !== 'cancelled') setNote(res.error);
  };

  const onUse = async (engine: string, spec: string) => {
    setNote(null);
    if (busyTurn) await pausePi();
    const res = await switchProfile(engine, spec);
    if (!res.success) setNote(res.error ?? 'could not switch');
  };

  return (
    <span className="pd-engine-trigger">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconButton
            aria-label="Engines and speed"
            aria-pressed={open}
            data-testid="engine-menu-button"
            className="[-webkit-app-region:no-drag]"
          >
            {/* The inference engines' mark: the graphics card (the user's pick). */}
            <Glyph name="engine" size={16} />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent
          className="pd-engine-menu"
          side="bottom"
          align="start"
          sideOffset={6}
          data-testid="engine-menu"
        >
          <div className="pd-engine-head">
            <div className="pd-engine-head-text">
              <span className="pd-engine-head-title">Engines</span>
              <span className="pd-engine-head-sub" data-testid="engine-menu-running">
                {model !== null && model !== undefined
                  ? `${model.displayName} · ${engineName(status.profile?.engine ?? 'llamacpp')}${
                      status.profile !== undefined ? ` · ${specLabel(status.profile.spec)}` : ''
                    }`
                  : 'No model running'}
              </span>
              <ThroughputLine />
            </div>
            <div className="pd-engine-head-actions">
              {running ? (
                <button
                  type="button"
                  className="pd-engine-calibrate pd-engine-calibrate--cancel"
                  data-testid="engine-calibrate-cancel"
                  onClick={() => void cancelCalibration()}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="pd-engine-calibrate"
                  data-testid="engine-calibrate"
                  disabled={!canCalibrate}
                  title={
                    canCalibrate
                      ? 'Measure every engine and method for this model, then switch to the fastest'
                      : 'Start a model first'
                  }
                  onClick={() => void onCalibrate()}
                >
                  {record !== null ? 'Recalibrate' : 'Calibrate'}
                </button>
              )}
              <FetchMissingButton open={open} plan={plan} onNote={setNote} />
            </div>
          </div>
          <VisionRow onNote={setNote} />
          {model !== null && model !== undefined && record === null && !running ? (
            /* Per model: a model that has never been measured says so, whatever
               another model's verdict was. */
            <div className="pd-engine-note" data-testid="engine-menu-uncalibrated">
              Not calibrated yet for {model.displayName} — running on{' '}
              {engineName(status.profile?.engine ?? 'llamacpp')} by default.
            </div>
          ) : null}
          {note !== null ? (
            <div className="pd-engine-note" data-testid="engine-menu-note">
              {sayIfRaw(note, 'engine')}
            </div>
          ) : null}
          <CalibrationSection onUse={(e, s) => void onUse(e, s)} plan={plan} />
          <div className="pd-engine-section pd-engine-section--list">
            <div className="pd-engine-section-title">Available on this machine</div>
            <div className="pd-engine-list" data-testid="engine-menu-list">
              {rows.map(({ spec }) => (
                <EngineRow
                  key={spec.id}
                  spec={spec}
                  host={host as HostCapabilities}
                  state={engines[spec.id]}
                  active={status.profile?.engine === spec.id && status.serverRunning}
                  onInstall={() =>
                    void installEngine(spec.id).then((r) => {
                      if (!r.success) setNote(r.error ?? `could not install ${spec.name}`);
                    })
                  }
                />
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <LiveReadout />
    </span>
  );
}
