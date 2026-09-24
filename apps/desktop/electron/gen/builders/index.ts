/**
 * GENERATION JOB BUILDERS — one per engine family, each in its own file.
 *
 * gen-manager.ts builds every job inline today (the mflux branch, the ComfyUI
 * branch). The push adds more engines — Ming's mlx-vlm design model (MING-3),
 * the edit engines (IMG-04), remote generation (DEV-12) — and six lanes editing
 * one 1,565-line file is the conflict the plan exists to avoid. So after
 * GEN-SEAM (lane EDIT, W1) nobody edits gen-manager.ts for a new engine: each
 * feature adds a builder in `electron/gen/builders/<name>.ts`
 * (deliverables/research/PLAN.md §1.3 item 5, R5).
 *
 * SKELETON from the W0-A pre-wire: the builder shape, the registry and the two
 * planned builder files (empty lists, so their lanes fill them without touching
 * this one). GEN-SEAM moves today's inline branches here and routes the queue
 * through {@link builderFor}; until then nothing reads this registry.
 */
import type { GenJob, Modality, ModalityModel } from '@pi-desktop/gen-service';
import { EDIT_JOB_BUILDERS } from './edit';
import { MLX_VLM_JOB_BUILDERS } from './mlx-vlm';

export interface GenJobBuildContext {
  readonly jobId: string;
  /** Where the job's outputs land. */
  readonly outputDir: string;
}

export interface GenJobBuilder {
  /** Stable, for the log and for replacing a registration: `mlx-vlm-design`. */
  readonly id: string;
  readonly modality: Modality;
  /** Whether this builder makes the job for that catalog entry. */
  readonly handles: (model: ModalityModel) => boolean;
  /**
   * The queue job for one request. `params` is the request as the IPC or the
   * bridge delivered it; a builder validates what it reads.
   */
  readonly build: (model: ModalityModel, params: unknown, ctx: GenJobBuildContext) => GenJob;
}

/** The builders that ship in files of their own (one list per planned file). */
export const GEN_JOB_BUILDERS: readonly GenJobBuilder[] = [
  ...MLX_VLM_JOB_BUILDERS,
  ...EDIT_JOB_BUILDERS,
];

const registered = new Map<string, GenJobBuilder>();

/** Add a builder at runtime (a feature's own module). Same id replaces. */
export function registerGenJobBuilder(builder: GenJobBuilder): () => void {
  registered.set(builder.id, builder);
  return () => {
    if (registered.get(builder.id) === builder) registered.delete(builder.id);
  };
}

/** Every builder: the shipped lists first, then runtime registrations. */
export function genJobBuilders(): readonly GenJobBuilder[] {
  return [...GEN_JOB_BUILDERS, ...registered.values()];
}

/** The first builder that makes jobs for `model` (optionally of one modality). */
export function builderFor(model: ModalityModel, modality?: Modality): GenJobBuilder | undefined {
  return genJobBuilders().find(
    (b) => (modality === undefined || b.modality === modality) && b.handles(model),
  );
}
