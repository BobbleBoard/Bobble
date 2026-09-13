/**
 * THE ENGINE MENU — a small speedometer right of the chat's name.
 *
 * the user: "at the top bar, to the right of the chat name, show a little icon,
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
import { IconButton, IconSpeed, Popover, PopoverContent, PopoverTrigger } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { EngineState } from '../../electron/ipc-contract';
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

/** How the menu names an engine id (matches the catalogue where it has a row). */
function engineName(id: string): string {
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
  return (
    <span className="pd-engine-tps pd-engine-tps--idle" data-testid="engine-menu-tps">
      tok/s shows while a reply streams
    </span>
  );
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
          <span className="pd-engine-row-sub pd-engine-row-sub--error">{done.error}</span>
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
          <span className="pd-engine-row-sub pd-engine-row-sub--error">failed</span>
        )}
      </span>
    </button>
  );
}

function CalibrationSection({ onUse }: { onUse: (engine: string, spec: string) => void }) {
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
        skips: calibration.skips,
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
      skips: rec.skips.map((k) => ({
        ...k,
        label: `${engineName(k.engine)} · ${specLabel(k.spec)}`,
      })),
      chosen: rec.chosen,
      error: null,
      at: rec.at,
    };
  }, [calibration, record]);

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
          {rows.error}
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
            >
              <span>{k.label}</span>
              <span className="pd-engine-row-sub">{k.reason}</span>
            </div>
          ))}
          {/* A skip for a missing FILE is a download away: fetch what the
              catalogue names for this model (drafters, MLX twin, MTP head) and
              the next calibration measures those rows too. */}
          {rows.skips.some((k) => /not downloaded|on disk/.test(k.reason)) ? (
            <FetchMissingButton />
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/** Download every companion the catalogue names for the running model. */
function FetchMissingButton() {
  const model = useLlmStore((s) => s.status.model);
  const download = useLlmStore((s) => s.download);
  const downloadModel = useLlmStore((s) => s.downloadModel);
  if (model === null || model === undefined) return null;
  const busy = download !== null && download.modelId === model.id;
  return (
    <button
      type="button"
      className="pd-engine-install"
      data-testid="engine-fetch-missing"
      disabled={busy}
      onClick={() => void downloadModel(model.id, model.quant)}
    >
      {busy ? 'Fetching…' : 'Fetch the missing drafters'}
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
          <span className="pd-engine-row-sub pd-engine-row-sub--error">{state.error}</span>
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
            <IconSpeed size={16} />
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
          </div>
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
              {note}
            </div>
          ) : null}
          <CalibrationSection onUse={(e, s) => void onUse(e, s)} />
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
