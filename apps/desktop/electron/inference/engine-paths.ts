/**
 * WHERE THE ENGINES LIVE, answered the same way by everyone who asks.
 *
 * Two processes need to know whether rapid-mlx is installed: the main process
 * (Settings → Engines draws the row) and the inference supervisor (calibration
 * plans a candidate). Each used to answer for itself, which is how a panel and a
 * launch get to disagree. This module is the one answer — pure path arithmetic
 * plus an `existsSync`, so both bundles can carry it.
 *
 * "Installed" means the CLI the launch would exec is on disk. A package whose
 * dist-info survived but whose entry point did not is not installed in any
 * sense that matters to a launch.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';

/** The managed Python venv shared by every MLX engine. */
export function mlxVenvRoot(): string {
  return path.join(cacheRoot(), 'engines', 'mlx-venv');
}

/** The managed venv for vLLM (Linux; CUDA/ROCm wheels are their own world). */
export function vllmVenvRoot(): string {
  return path.join(cacheRoot(), 'engines', 'vllm-venv');
}

/** The engines that are launched as an OpenAI-compatible CLI from a venv. */
export type VenvEngine = 'mlx-lm' | 'rapid-mlx' | 'dflash-mlx' | 'mlx-dspark' | 'omlx' | 'vllm';

/** Absolute path of the CLI a launch would exec for this engine. */
export function engineCommand(engine: VenvEngine): string {
  switch (engine) {
    case 'mlx-lm':
      return path.join(mlxVenvRoot(), 'bin', 'mlx_lm.server');
    case 'rapid-mlx':
      return path.join(mlxVenvRoot(), 'bin', 'rapid-mlx');
    case 'dflash-mlx':
      return path.join(mlxVenvRoot(), 'bin', 'dflash');
    case 'mlx-dspark':
      return path.join(mlxVenvRoot(), 'bin', 'mlx-dspark');
    case 'omlx':
      return path.join(mlxVenvRoot(), 'bin', 'omlx');
    case 'vllm':
      return path.join(vllmVenvRoot(), 'bin', 'vllm');
    default:
      throw new Error(`unknown engine ${String(engine)}`);
  }
}

export function engineInstalled(engine: VenvEngine): boolean {
  return existsSync(engineCommand(engine));
}

export const VENV_ENGINES: readonly VenvEngine[] = [
  'mlx-lm',
  'rapid-mlx',
  'dflash-mlx',
  'mlx-dspark',
  'omlx',
  'vllm',
];

/** Every venv engine whose CLI is on disk right now. */
export function installedVenvEngines(): VenvEngine[] {
  return VENV_ENGINES.filter((e) => engineInstalled(e));
}

/**
 * The directory oMLX is pointed at: one subdirectory per model, each a
 * symlink to the weights in the model store. oMLX discovers models by
 * directory name, so this is also how a served model gets its id.
 */
export function omlxModelRoot(): string {
  return path.join(cacheRoot(), 'engines', 'omlx-models');
}

/**
 * Where a calibration's verdict is kept, per model. Beside the engines rather
 * than the models: deleting a model's weights should not have to know about
 * a measurement, and re-downloading them should find it still valid.
 */
export function calibrationDir(): string {
  return path.join(cacheRoot(), 'calibration');
}
