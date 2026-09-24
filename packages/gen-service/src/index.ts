/**
 * @pi-desktop/gen-service — the generation backend core: a REMOTE-CAPABLE job
 * protocol, the verified modality catalog, a uv-managed Python worker
 * (mflux/MLX for image today; audio/video/3d pluggable behind the same
 * envelope), a Node client that streams the worker's NDJSON events, and a
 * unified-memory-budget-aware JobQueue.
 *
 * Electron-free: the Electron gen manager imports this and adds the socket
 * bridge + IPC. Nothing here touches Electron or React.
 */
export type {
  License,
  MfluxBackendConfig,
  ModalityModel,
  PreparedWeights,
  WeightFile,
} from './catalog.js';
export {
  activeModels,
  default3dModel,
  defaultImageModel,
  defaultVideoModel,
  getModel,
  jobFootprintGB,
  MODALITY_CATALOG,
  modelsForModality,
  previewCostGB,
  requiresLicenseGate,
} from './catalog.js';
export type {
  GenChildProcess,
  GenReadable,
  GenServiceClientOptions,
  GenSpawnFn,
  GenWritable,
  RunJobOptions,
} from './client.js';
export { defaultGenSpawn, GenAbortError, GenServiceClient } from './client.js';
export type {
  ComfyClientDeps,
  ComfyRunOptions,
  ComfyWebSocket,
  ComfyWsFactory,
} from './comfy-client.js';
export { ComfyClient, defaultComfyWsFactory } from './comfy-client.js';
export type {
  ComfyLaunchConfig,
  ComfySupervisorHandle,
  CreateComfySupervisorOptions,
} from './comfy-supervisor.js';
export { buildComfyArgs, createComfySupervisor } from './comfy-supervisor.js';
export type { ComfyGraph, ComfyNode, ModelFinish, WorkflowTemplate } from './comfy-workflow.js';
export {
  fillWorkflow,
  getWorkflowTemplate,
  imageTo3dTemplateFor,
  WORKFLOW_TEMPLATES,
} from './comfy-workflow.js';
export type { GenRunnerLike, MakeGenRunnerDeps } from './gen-runner.js';
export { makeGenRunner } from './gen-runner.js';
export type {
  EnqueueOptions,
  JobHandle,
  JobQueueEvent,
  JobQueueListener,
  JobQueueOptions,
  JobRunner,
  JobStatus,
} from './job-queue.js';
export { JobQueue } from './job-queue.js';
// OmniSVG — text/image → SVG through the app's own llama-server. Pure halves:
// the request/reply shape and the token → SVG decoder (checked byte-for-byte
// against the authors' decoder). The process that runs the server is the app's.
export type { DecodedPath } from './omnisvg-decode.js';
export {
  colorFromToken,
  decodeOmniSvg,
  decodeOmniSvgPartial,
  OMNISVG_4B,
  pathsToSvg,
  tokensToXY,
  xyToPaths,
} from './omnisvg-decode.js';
export type { OmniSvgCompletion, OmniSvgRequest, OmniSvgSampling } from './omnisvg-request.js';
export {
  buildOmniSvgRequest,
  idsFromCompletion,
  MEDIA_MARKER,
  OMNISVG_MAX_TOKENS,
  OMNISVG_SAMPLING,
  OMNISVG_SYSTEM_PROMPT,
  textSubtype,
} from './omnisvg-request.js';
export type {
  AudioJobSpec,
  Backend,
  ComfyBackendConfig,
  ComfyJobSpec,
  GenEvent,
  GenJob,
  GenOutput,
  ImageJobSpec,
  Modality,
  TerminalGenEvent,
  VideoJobSpec,
} from './protocol.js';
export { isGenEvent, NdjsonParser, parseGenEventLine } from './protocol.js';
export type { WorkerUvArgsOptions } from './worker-command.js';
export {
  backendUvFlags,
  baseWorkerWith,
  buildEnvWarmArgs,
  buildWorkerUvArgs,
  bundledMlxVlmWheel,
  bundledWheelPath,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
  MLX_AUDIO_PIN,
  MLX_VLM_COMMIT,
  MLX_VLM_RESOLVED_BEFORE,
  MLX_VLM_WHEEL,
  resolveWorkerScript,
} from './worker-command.js';
