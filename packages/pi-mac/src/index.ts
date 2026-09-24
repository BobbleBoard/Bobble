/**
 * @pi-desktop/pi-mac — the Mac computer-use bridge helper.
 *
 * A Swift `pi-mac` CLI (indexed Accessibility-tree snapshot + CGEvent
 * click/type/key/scroll + a TCC status probe) plus this electron-free Node
 * wrapper: `checkTcc` (the capability gate) and `MacHelperClient` (the long-
 * lived `--serve` NDJSON client Electron main drives). The desktop app injects
 * the bundle-relative helper path; nothing here imports electron.
 *
 * `MacVisionClient` speaks to the same binary's `--vision-serve` mode: Apple
 * Vision on image files (instance masks, the instance under a tap, OCR) for
 * the image editor. It needs no permission.
 */
export { type CheckTccOptions, checkTcc, parseCheckLine } from './check.js';
export {
  buildHelper,
  devHelperPath,
  helperPath,
  swiftDir,
} from './helper-path.js';
export { MacHelperClient, type MacHelperClientOptions } from './serve-client.js';
export {
  defaultSpawn,
  type MacChildProcess,
  type MacReadable,
  type MacSpawnFn,
  type MacWritable,
} from './spawn.js';
export type { TccStatus } from './types.js';
export {
  MacVisionClient,
  type MacVisionClientOptions,
  parseVisionForget,
  parseVisionInfo,
  parseVisionInstanceAt,
  parseVisionLift,
  parseVisionOcr,
  parseVisionWarm,
  VISION_DEFAULT_TIMEOUT_MS,
  VisionArgumentError,
  VisionContractError,
} from './vision.js';
export {
  VISION_INSTANCE_OUTPUTS,
  VISION_LIFT_OUTPUTS,
  VISION_PROTOCOL_VERSION,
  type VisionBox,
  type VisionForeground,
  type VisionForgetResult,
  type VisionImageParams,
  type VisionInfo,
  type VisionInstance,
  type VisionInstanceAtParams,
  type VisionInstanceAtResult,
  type VisionInstanceOutput,
  type VisionLiftOutput,
  type VisionLiftParams,
  type VisionLiftResult,
  type VisionOcrLevel,
  type VisionOcrLine,
  type VisionOcrParams,
  type VisionOcrResult,
  type VisionOcrWord,
  type VisionOutputParams,
  type VisionPoint,
  type VisionWarmResult,
} from './vision-types.js';
