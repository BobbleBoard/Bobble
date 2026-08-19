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

        {runtimeMissing ? (
          <p className="tp-gate-copy">
            Bobble runs 3D generation through a local Python engine, and it could not be started.
            Installing <code>uv</code> gives it what it needs — nothing else here has to change.
          </p>
        ) : state.status === 'installing' ? (
          <p className="tp-gate-copy" data-testid="tp-gate-progress">
            {inFlight.length > 0
              ? `Fetching ${inFlight.map((m) => m.label).join(', ')}…`
              : 'Starting the download…'}{' '}
            You can keep using the rest of Bobble while this runs.
          </p>
        ) : (
          <p className="tp-gate-copy">
            Generate 3D models from text or an image, retopologise, segment, rig and animate them —
            all on this Mac, offline once downloaded. The rest of Bobble works without it.
          </p>
        )}

        {error !== null ? (
          <p className="tp-gate-error" data-testid="tp-gate-error">
            {error}
          </p>
        ) : null}

        <div className="tp-gate-actions">
          {runtimeMissing ? null : (
            <button
              type="button"
              className="tp-gate-primary"
              data-testid="tp-gate-download"
              disabled={state.status === 'installing' || starting || size === ''}
              onClick={start}
            >
              <IcDownload size={15} />
              {state.status === 'installing' || starting
                ? 'Downloading…'
                : /* No size means the catalog has not answered yet; asking for a
                     download we cannot cost is how a button lies. */
                  size === ''
                  ? 'Checking…'
                  : `Download module (${size})`}
            </button>
          )}
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
