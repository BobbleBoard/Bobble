/**
 * IS THE 3D MODULE THERE AT ALL?
 *
 * Everything else in the studio asks "is THIS stage's model installed" — a
 * per-stage question with a per-stage download button. This asks the question
 * above that one: does this machine have the 3D module at all?
 *
 * the user: "the app can totally function WITHOUT having installed either or any of
 * the models, or either or the whole 3d module, and tabs/3d studio button as a
 * whole are properly greyed out and their workspaces are blurred with a few
 * buttons that say 'download module (nGB)' and a separate 'View' button so they
 * can see the UI removing the blur (obviously can't use it without download but
 * just so we're not gatekeeping the UI from being seen at all as if it's a paid
 * service)."
 *
 * So this file owns one judgement, kept pure and tested, because the whole
 * gating UI hangs off it and "greyed out" must never be a guess.
 */
import type { Gen3dModelId, Gen3dModelInfo } from '../../electron/gen3d/gen3d-contract';

/**
 * The models that make the studio USEFUL, in the order a first run needs them.
 *
 * Deliberately NOT every model in the catalog. A machine with geometry but no
 * motion model can still generate, retopologise, segment and rig — calling that
 * "not installed" would hide a working studio behind a 40GB wall. These four are
 * the spine: an image hop, geometry, quad retopology, and the local rigger.
 * Everything else (motion, learned rig, edit, audio) is an optional extra with
 * its own in-panel download.
 */
export const CORE_MODULE_MODELS: readonly Gen3dModelId[] = [
  'mageflow',
  'trellis2',
  'autoremesher',
  'humanoid-rig',
];

export type ModuleStatus =
  /** The engine runtime itself is missing (no uv/Python sidecar). */
  | 'no-runtime'
  /** Runtime is up but the core models are not all there. */
  | 'not-installed'
  /** Some core models are downloading right now. */
  | 'installing'
  /** Ready to use. */
  | 'ready';

export interface ModuleState {
  readonly status: ModuleStatus;
  /** Bytes still to fetch for the CORE set (0 when ready). */
  readonly remainingBytes: number;
  /** Which core models are missing, in install order. */
  readonly missing: readonly Gen3dModelId[];
  /** True when the studio can actually run something. */
  readonly usable: boolean;
}

/**
 * Judge the module from the catalog the sidecar reported.
 *
 * `engineReady === false` means the uv/Python sidecar is not up, which is a
 * DIFFERENT problem from "the weights are missing" and gets its own wording —
 * telling someone to download 34GB when the real fix is installing uv would
 * waste an hour and their bandwidth.
 */
export function moduleState(engineReady: boolean, models: readonly Gen3dModelInfo[]): ModuleState {
  const core = CORE_MODULE_MODELS.map((id) => models.find((m) => m.id === id)).filter(
    (m): m is Gen3dModelInfo => m !== undefined,
  );
  const missing = core.filter((m) => !m.installed);
  const remainingBytes = missing.reduce((n, m) => n + m.sizeBytes, 0);
  const anyDownloading = core.some((m) => m.downloading);

  if (!engineReady) {
    return {
      status: 'no-runtime',
      remainingBytes,
      missing: missing.map((m) => m.id),
      usable: false,
    };
  }
  // An empty catalog is "we do not know yet", not "nothing is installed" — the
  // sidecar answers before it has booted. Treat it as not-installed but with no
  // size claim, so the panel never invents a number.
  if (missing.length === 0 && core.length > 0) {
    return { status: 'ready', remainingBytes: 0, missing: [], usable: true };
  }
  return {
    status: anyDownloading ? 'installing' : 'not-installed',
    remainingBytes,
    missing: missing.map((m) => m.id),
    usable: false,
  };
}

/** "34.2 GB" / "870 MB" — the size on the download button. */
export function formatModuleSize(bytes: number): string {
  if (bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** One line explaining the state, for the gate panel. */
export function moduleHeadline(state: ModuleState): string {
  switch (state.status) {
    case 'no-runtime':
      return 'The 3D engine runtime is not available';
    case 'installing':
      return 'Downloading the 3D module…';
    case 'not-installed':
      return '3D module not installed';
    case 'ready':
      return '3D module ready';
  }
}
