/**
 * The accelerator as the engine catalogue wants to hear about it.
 *
 * `LlmHardware` (the inference probe's report) is where the card's vendor and
 * name live; `HostCapabilities.gpu` is what `engineSupport` reads to keep a
 * card-specific engine (NInfer is an RTX 5090, its fork an RTX 3090) off every
 * other box with the card named in the reason. Null until the probe has
 * answered — and null is "not identified", which the support check treats as
 * "not that card", never as "maybe".
 */
import type { LlmHardware } from '../../electron/ipc-contract';
import type { HostCapabilities } from './engine-catalog';

export function hostGpuOf(hw: LlmHardware | null): HostCapabilities['gpu'] {
  if (hw === null || hw.gpuVendor === undefined) return null;
  return { vendor: hw.gpuVendor, ...(hw.gpuName !== undefined ? { name: hw.gpuName } : {}) };
}
