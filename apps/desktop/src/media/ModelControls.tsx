/**
 * THE STRIP UNDER A 3D CARD. The user (2026-09-17): "below the card itself show
 * some basic controls eg. coloring/normals/grey, if rig, skeleton and if
 * segment, then explode."
 *
 * The app's own segmented control (packages/ui controls.css `.pd-segmented`)
 * for the three shadings, and the same pill as a switch for each overlay the
 * file has earned — never a Skeleton for a model without a rig, never an
 * Explode for one that is not in parts (model-view.ts `controlsFor`).
 */
import { type JSX, useSyncExternalStore } from 'react';
import { controlsFor, type ModelView } from './model-view';

export function ModelControls({ view }: { view: ModelView }): JSX.Element {
  const state = useSyncExternalStore(view.subscribe, view.get, view.get);
  const controls = controlsFor(state);
  return (
    <div className="pd-media-model-controls" data-testid="model-controls">
      <div className="pd-segmented" data-testid="model-shading">
        {controls.shading.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={state.shading === s.id}
            className="pd-segment pd-focusable"
            data-state={state.shading === s.id ? 'active' : undefined}
            data-testid={`model-shading-${s.id}`}
            onClick={() => view.set({ shading: s.id })}
          >
            {s.label}
          </button>
        ))}
      </div>
      {controls.skeleton ? (
        <div className="pd-segmented">
          <button
            type="button"
            role="switch"
            aria-checked={state.skeleton}
            className="pd-segment pd-focusable"
            data-state={state.skeleton ? 'on' : undefined}
            data-testid="model-skeleton"
            onClick={() => view.set({ skeleton: !state.skeleton })}
          >
            Skeleton
          </button>
        </div>
      ) : null}
      {controls.explode ? (
        <div className="pd-segmented">
          <button
            type="button"
            role="switch"
            aria-checked={state.explode}
            className="pd-segment pd-focusable"
            data-state={state.explode ? 'on' : undefined}
            data-testid="model-explode"
            onClick={() => view.set({ explode: !state.explode })}
          >
            Explode
          </button>
        </div>
      ) : null}
    </div>
  );
}
