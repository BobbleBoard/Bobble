/**
 * THE FEW CONTROLS UNDER A 3D CARD, as state the viewport and the strip share.
 *
 * The user (2026-09-17): "the card should just be a little embedded viewport
 * rotatable, not all the controls but below the card itself show some basic
 * controls eg. coloring/normals/grey, if rig, skeleton and if segment, then
 * explode." So: three ways to shade, and two overlays that exist only when the
 * file earns them — a Skeleton toggle when it carries a rig, an Explode toggle
 * when it is split into parts. The studio keeps its lighting, wireframe, grid
 * and export; none of that is what a card in a conversation is for.
 *
 * Pure: no React, no three. The card makes one of these, the viewport applies
 * it to its scene and reports what the file has, the strip renders it. Tests
 * pin the rules (which controls appear, what a fresh file defaults to).
 */

export type ModelShading = 'color' | 'normals' | 'grey';

export interface ModelViewState {
  readonly shading: ModelShading;
  /** Draw the rig through the surface. Meaningful only when {@link hasSkeleton}. */
  readonly skeleton: boolean;
  /** Push the parts apart from the centre. Meaningful only when {@link parts} ≥ 2. */
  readonly explode: boolean;
  /** What the loaded file has — set by the viewport once the file is read. */
  readonly hasSkeleton: boolean;
  readonly parts: number;
  readonly loaded: boolean;
}

export interface ModelView {
  get(): ModelViewState;
  set(patch: Partial<ModelViewState>): void;
  subscribe(listener: () => void): () => void;
}

export const DEFAULT_MODEL_VIEW: ModelViewState = {
  shading: 'color',
  skeleton: false,
  explode: false,
  hasSkeleton: false,
  parts: 0,
  loaded: false,
};

export function createModelView(initial: Partial<ModelViewState> = {}): ModelView {
  let state: ModelViewState = { ...DEFAULT_MODEL_VIEW, ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch };
      let changed = false;
      for (const k of Object.keys(next) as (keyof ModelViewState)[]) {
        if (next[k] !== state[k]) changed = true;
      }
      if (!changed) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * What the viewport found in the file, folded into the view.
 *
 * A RIG IS SHOWN THE MOMENT IT ARRIVES: a `refine_3d rig` result's whole
 * point is the skeleton, and a card that hides it behind a toggle shows a
 * model that looks exactly like the one before the rig. Parts stay together
 * until asked — an exploded model is a diagram, not the model.
 */
export function fileFacts(view: ModelView, facts: { hasSkeleton: boolean; parts: number }): void {
  const cur = view.get();
  view.set({
    hasSkeleton: facts.hasSkeleton,
    parts: facts.parts,
    loaded: true,
    skeleton: facts.hasSkeleton ? (cur.loaded ? cur.skeleton : true) : false,
    explode: facts.parts >= 2 ? cur.explode : false,
  });
}

/** The controls the strip draws for this file — never a toggle for a thing the file lacks. */
export function controlsFor(state: ModelViewState): {
  shading: readonly { id: ModelShading; label: string }[];
  skeleton: boolean;
  explode: boolean;
} {
  return {
    shading: SHADINGS,
    skeleton: state.hasSkeleton,
    explode: state.parts >= 2,
  };
}

export const SHADINGS: readonly { id: ModelShading; label: string }[] = [
  { id: 'color', label: 'Color' },
  { id: 'normals', label: 'Normals' },
  { id: 'grey', label: 'Grey' },
];

/**
 * Is this mesh one of a segmentation's parts? The engine names them
 * `part_00_main_body … part_04_right_part` (verified on a run's parts.glb).
 */
export function isPartName(name: string): boolean {
  return /^part_\d+/i.test(name);
}

/**
 * How many parts a file's mesh names describe — the engine's `part_NN_*`
 * bodies, and only those. A model whose primitives happen to be several
 * meshes ("mesh_0", "mesh_1": one material each) is not segmented, and an
 * Explode that tore a whole model along its material seams would be a
 * control the file did not earn ("if segment, then explode").
 */
export function countParts(meshNames: readonly string[]): number {
  const engine = meshNames.filter(isPartName).length;
  return engine >= 2 ? engine : 0;
}
