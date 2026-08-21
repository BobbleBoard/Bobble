/**
 * THE MANIFEST — what the app knows about one model on this disk.
 *
 * the user wanted the store to answer, for anything we add now or later: where are
 * its weights, what is it called, what else do we know. So every entry carries
 * that in one file beside the weights, and the index is just those files read
 * back. A sidecar rather than a central database, for one reason worth stating:
 * a central index and the disk can disagree, and when they do the index wins and
 * the user is told they have a model they deleted. A manifest cannot outlive its
 * own directory.
 *
 * TASKS ARE PART OF THE IDENTITY, not a footnote. the user: "ltx 2.5 and minimax I
 * think have a lot of sub models or something complicated where you download one
 * per like in-out you want eg. video+text-video or image-video or start+endframe
 * -video or text-video etc." That is true, and it means "do I have LTX-2.5?" is
 * not a yes/no question — you have the image-to-video weights and not the
 * start-and-end-frame ones. `tasks` records which of those this download can do,
 * so the UI can say so instead of implying the whole family arrived.
 */
import type { ModelKind } from './layout.js';

/**
 * An in→out job a model can perform, in the Hugging Face spelling where one
 * exists (`text-to-video`, `image-to-video`) plus the ones it has no word for.
 */
export type ModelTask =
  | 'text-to-text'
  | 'image-text-to-text'
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video'
  | 'keyframes-to-video'
  | 'text-to-speech'
  | 'text-to-audio'
  | 'image-to-3d'
  | 'text-to-3d'
  | 'text-to-motion';

/** Where an entry came from, which decides who is allowed to delete it. */
export type ModelSource = 'store' | 'llm' | 'gen3d';

export interface StoredFile {
  /** Path relative to the model's directory, as published by the repo. */
  readonly path: string;
  readonly bytes: number;
}

export interface StoredModel {
  /** Stable id — the slug, so it is derivable from the repo and never guessed. */
  readonly id: string;
  /** Hugging Face repo this came from. */
  readonly repo: string;
  /** What to call it on screen. */
  readonly name: string;
  /** Curated family id, when it belongs to one — lets the hub group it. */
  readonly family?: string;
  readonly org: string;
  readonly kind: ModelKind;
  /** The in→out jobs these weights actually perform. See the file docstring. */
  readonly tasks?: readonly ModelTask[];
  /** Which runtime loads it: 'llamacpp' | 'mlx' | 'diffusers' | 'trellis' | … */
  readonly backend?: string;
  /** ABSOLUTE directory holding the weights. */
  readonly dir: string;
  readonly files: readonly StoredFile[];
  readonly bytes: number;
  /** ISO 8601. */
  readonly installedAt: string;
  readonly source: ModelSource;
  /** GGUF quant label, when the download was one file of a ladder. */
  readonly quant?: string;
  readonly notes?: string;
  /**
   * Written at the START of a download and cleared when it finishes. A manifest
   * still carrying it describes a directory that was interrupted — which is how
   * the store can tell a finished model from an abandoned one WITHOUT trusting
   * that a cancel got the chance to tidy up (a crash or a pulled plug never
   * gets that chance).
   */
  readonly incomplete?: boolean;
}

export const MANIFEST_VERSION = 1;

interface ManifestFile {
  readonly version: number;
  readonly model: StoredModel;
}

export function serializeManifest(model: StoredModel): string {
  const body: ManifestFile = { version: MANIFEST_VERSION, model };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Parse a manifest, or undefined when the file is not one.
 *
 * Deliberately forgiving about EXTRA fields and strict about the few that the
 * app would misbehave without: a manifest written by a later version should
 * still list, because the alternative is a model that exists on disk and is
 * invisible in the UI.
 */
export function parseManifest(text: string): StoredModel | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== 'object' || model === null) return undefined;
  const m = model as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : undefined;
  const repo = typeof m.repo === 'string' ? m.repo : undefined;
  const dir = typeof m.dir === 'string' ? m.dir : undefined;
  const kind = typeof m.kind === 'string' ? (m.kind as ModelKind) : undefined;
  if (id === undefined || repo === undefined || dir === undefined || kind === undefined) {
    return undefined;
  }
  return model as StoredModel;
}

/** Total bytes across a set of entries — the "how much disk is this costing" line. */
export function totalBytes(models: readonly StoredModel[]): number {
  return models.reduce((sum, m) => sum + (Number.isFinite(m.bytes) ? m.bytes : 0), 0);
}

/** Group by what they make, in the order the UI shows the kinds. */
export function byKind(models: readonly StoredModel[]): Map<ModelKind, StoredModel[]> {
  const out = new Map<ModelKind, StoredModel[]>();
  for (const m of models) {
    const list = out.get(m.kind);
    if (list === undefined) out.set(m.kind, [m]);
    else list.push(m);
  }
  return out;
}
