/**
 * THE DOWNLOAD BUTTON — one card per generation module.
 *
 * the user (2026-09-13): "in the shipped app I just get a bunch of 'uv not
 * installed' errors, we need a popup/prominent button that has something like
 * 'download module' for image/audio/3d/video."
 *
 * The same card in two places. In a STUDIO it sits above the composer for as
 * long as the module is not on this Mac, so the first thing a person sees in
 * the Image studio on a fresh install is the way to make it work. In the CHAT
 * it appears the moment the model asks for a picture, a voice or a clip the
 * Mac cannot make yet — the job is waiting at the gate (gen-modules.ts) for
 * this button, and continues the moment the install lands. Closing it there
 * lets the job fail with a sentence the model can repeat, rather than leaving
 * it hanging.
 *
 * While the install runs, the button becomes the progress: uv's own lines
 * ("Downloading torch (215MiB)"), a bar when a phase can say how far, the
 * failure in place with a Try again.
 */

import { useEffect } from 'react';
import type { GenModuleId } from '../../electron/gen/gen-modules';
import { useGenModule, useGenModulesStore } from '../state/gen-modules-store';

export interface ModuleCardProps {
  readonly id: GenModuleId;
  /** Where it is shown — the chat card can be closed, the studio's cannot. */
  readonly place: 'chat' | 'studio';
  /** The chat: the sentence about what asked for it. */
  readonly why?: string;
}

export function ModuleCard({ id, place, why }: ModuleCardProps) {
  const mod = useGenModule(id);
  const loaded = useGenModulesStore((s) => s.loaded);
  const install = useGenModulesStore((s) => s.install);
  const dismiss = useGenModulesStore((s) => s.dismiss);
  const refresh = useGenModulesStore((s) => s.refresh);
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);
  if (mod === undefined || mod.ready) return null;

  const gb = mod.approxGB >= 1 ? `${mod.approxGB} GB` : `${Math.round(mod.approxGB * 1000)} MB`;
  const percent = mod.percent !== undefined ? Math.round(mod.percent * 100) : undefined;
  return (
    <section
      className="pd-module-card"
      data-testid={`module-card-${id}`}
      data-place={place}
      data-installing={mod.installing ? 'true' : 'false'}
      aria-live="polite"
    >
      <div className="pd-module-card-main">
        <p className="pd-module-card-title">
          {mod.installing
            ? `Downloading the ${mod.label.toLowerCase()}…`
            : mod.error !== undefined
              ? `The ${mod.label.toLowerCase()} did not install`
              : `${mod.label} not installed`}
        </p>
        <p className="pd-module-card-sub">
          {mod.installing
            ? (mod.detail ?? 'Starting…')
            : mod.error !== undefined
              ? mod.error
              : `${why !== undefined ? `${why} ` : ''}${mod.blurb} About ${gb}, once.`}
        </p>
        {mod.installing ? (
          <div
            className="pd-module-card-track"
            data-indeterminate={percent === undefined ? 'true' : 'false'}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
          >
            <div
              className="pd-module-card-fill"
              style={percent !== undefined ? { width: `${percent}%` } : undefined}
            />
          </div>
        ) : null}
      </div>
      <div className="pd-module-card-actions">
        {mod.installing ? null : (
          <button
            type="button"
            className="pd-module-card-btn"
            onClick={() => void install(id)}
            data-testid={`module-install-${id}`}
          >
            {mod.error !== undefined ? 'Try again' : `Download ${mod.label.toLowerCase()}`}
          </button>
        )}
        {place === 'chat' && !mod.installing ? (
          <button
            type="button"
            className="pd-module-card-close"
            aria-label="Not now"
            title="Not now — the request stops, and the model is told why"
            onClick={() => void dismiss(id)}
            data-testid={`module-dismiss-${id}`}
          >
            Not now
          </button>
        ) : null}
      </div>
    </section>
  );
}
