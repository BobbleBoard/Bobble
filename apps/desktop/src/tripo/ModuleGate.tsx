/**
 * THE 3D MODULE GATE — what you see before the module is downloaded.
 *
 * the user: "their workspaces are blurred with a few buttons that say 'download
 * module (nGB)' and a separate 'View' button so they can see the UI removing the
 * blur (obviously can't use it without download but just so we're not
 * gatekeeping the UI from being seen at all as if it's a paid service)."
 *
 * So this is deliberately NOT a wall. The real studio renders behind it at full
 * fidelity and only a blur sits on top; "View" lifts the blur entirely and hands
 * the workspace over to be looked at, poked and understood. Nothing is hidden —
 * the download is a capability, not an unlock.
 *
 * Two things it must never do:
 *   - claim a size it does not know (an un-booted sidecar reports an empty
 *     catalog, and "Download 0 GB" is worse than no number at all);
 *   - blame the weights when the RUNTIME is what is missing — that sends someone
 *     to fetch 34GB when the fix is installing uv.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useGen3dStore } from './gen3d-client';
import { IcCube, IcDownload } from './icons';
import { formatModuleSize, type ModuleState, moduleHeadline } from './module-state';

export interface ModuleGateProps {
  readonly state: ModuleState;
  /** Lift the blur and let the workspace be inspected without downloading. */
  readonly onView: () => void;
}

export function ModuleGate({ state, onView }: ModuleGateProps): JSX.Element {
  const download = useGen3dStore((s) => s.download);
  const models = useGen3dStore((s) => s.models);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // While a download runs the panel should show it moving, not sit on a static
  // "installing…" — the sizes here are tens of gigabytes.
  const inFlight = models.filter((m) => m.downloading);

  useEffect(() => {
    if (state.status !== 'installing') setStarting(false);
  }, [state.status]);

  const size = formatModuleSize(state.remainingBytes);
  const runtimeMissing = state.status === 'no-runtime';
  /*
   * the user: "3D studio shows 'runtime is not available' on every first open of the
   * app even when previously installed." The engine's first catalog answer after
   * launch is always "not up yet" — it boots the Python sidecar behind itself —
   * so this panel offered to SET UP a module that was already installed and
   * about to work. While that boot is in flight there is nothing to offer and
   * nothing to warn about: it just says what is happening.
   */
  const booting = state.status === 'checking';

  const start = () => {
    if (state.missing.length === 0) return;
    setStarting(true);
    setError(null);
    void download(state.missing).then((why) => {
      if (why !== null) {
        setError(why);
        setStarting(false);
      }
    });
  };

  return (
    <div className="tp-gate" data-testid="tp-module-gate" data-status={state.status}>
      <div className="tp-gate-card">
        <span className="tp-gate-icon" aria-hidden>
          <IcCube size={26} />
        </span>
        <h2 className="tp-gate-title" data-testid="tp-gate-title">
          {moduleHeadline(state)}
        </h2>

        {booting ? (
          <p className="tp-gate-copy">The local engine is starting. This takes a few seconds.</p>
        ) : runtimeMissing ? (
          <p className="tp-gate-copy">Runs on a local Python engine. Bobble installs it for you.</p>
        ) : state.status === 'installing' ? (
          <p className="tp-gate-copy" data-testid="tp-gate-progress">
            {inFlight.length > 0
              ? `Fetching ${inFlight.map((m) => m.label).join(', ')}…`
              : 'Starting the download…'}{' '}
            Bobble keeps working while this runs.
          </p>
        ) : (
          <p className="tp-gate-copy">
            Text or image to 3D, then retopologise, segment, rig and animate. All on this Mac.
          </p>
        )}

        {error !== null ? (
          <p className="tp-gate-error" data-testid="tp-gate-error">
            {error}
          </p>
        ) : null}

        <div className="tp-gate-actions">
          {/* Nothing to press while the engine is coming up. */}
          {/*
            THE PRIMARY ACTION IS ALWAYS THERE, INCLUDING WITH NO RUNTIME.
            It used to be withheld exactly then, leaving a fresh Mac looking at
            a blurred studio with only "View" and a paragraph telling the user to
            go install `uv` themselves — which is the manual setup this module is
            supposed to be free of. The engine bootstraps its own runtime
            (ensureUv fetches a pinned, checksum-verified uv), so the same button
            starts the same flow; only the label differs, because "set up" and
            "download" are honestly different amounts of work.
          */}
          <button
            type="button"
            className="tp-gate-primary"
            hidden={booting}
            data-testid="tp-gate-download"
            disabled={state.status === 'installing' || starting}
            onClick={start}
          >
            <IcDownload size={15} />
            {state.status === 'installing' || starting
              ? runtimeMissing
                ? 'Setting up…'
                : 'Downloading…'
              : runtimeMissing
                ? /* The size is unknown until the engine answers, and it cannot
                     answer without a runtime — so this one names the action
                     rather than a number it does not have. */
                  'Set up 3D'
                : /* No size means the catalog has not answered yet; asking for a
                     download we cannot cost is how a button lies. */
                  size === ''
                  ? 'Checking…'
                  : `Download module (${size})`}
          </button>
          <button
            type="button"
            className="tp-gate-secondary"
            data-testid="tp-gate-view"
            onClick={onView}
          >
            View
          </button>
        </div>

        <p className="tp-gate-foot">
          View unblurs the studio so you can look around. Generating needs the module.
        </p>
      </div>
    </div>
  );
}
