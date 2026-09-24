/**
 * MacVisionClient — the Node half of `pi-mac --vision-serve`: Apple Vision on
 * image FILES for the image editor (foreground instance masks, the instance
 * under a tap, OCR).
 *
 * Same NDJSON wire and lifetime as the computer-use `--serve` bridge
 * (MacHelperClient), but its own process: a Vision request never queues in
 * front of a click, and the vision helper needs no permission at all.
 *
 * Every response is PARSED, not cast: a helper that drifts from the contract in
 * vision-types.ts fails loudly with the path of the field that is wrong
 * (`VisionContractError`), rather than handing the editor an undefined bbox to
 * draw. Arguments are checked before anything is spawned.
 */
import path from 'node:path';
import { MacHelperClient } from './serve-client.js';
import type { MacSpawnFn } from './spawn.js';
import {
  VISION_INSTANCE_OUTPUTS,
  VISION_LIFT_OUTPUTS,
  type VisionBox,
  type VisionForeground,
  type VisionForgetResult,
  type VisionInfo,
  type VisionInstance,
  type VisionInstanceAtParams,
  type VisionInstanceAtResult,
  type VisionLiftParams,
  type VisionLiftResult,
  type VisionOcrLevel,
  type VisionOcrLine,
  type VisionOcrParams,
  type VisionOcrResult,
  type VisionOcrWord,
  type VisionPoint,
  type VisionWarmResult,
} from './vision-types.js';

/**
 * The first ACCURATE OCR of a newly built helper takes ~29 s while macOS
 * prepares its text models (MEASURED on the M5; see Vision.swift), so the
 * default timeout leaves room for that one slow call on a slower Mac.
 */
export const VISION_DEFAULT_TIMEOUT_MS = 120_000;

export interface MacVisionClientOptions {
  /** Explicit helper binary (the packaged app injects the bundle path). */
  readonly helperPath?: string;
  /** Injectable spawn for tests. */
  readonly spawnFn?: MacSpawnFn;
  /** Per-request timeout (ms). Default {@link VISION_DEFAULT_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
  /** Each line the helper writes to stderr. */
  readonly onStderr?: (line: string) => void;
}

/** The helper answered, but not in the shape the contract promises. */
export class VisionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionContractError';
  }
}

/** The request was refused before reaching the helper. */
export class VisionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionArgumentError';
  }
}

// ── response parsing ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function fail(where: string, what: string): never {
  throw new VisionContractError(`pi-mac --vision: ${where} ${what}`);
}

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where, 'is not an object');
  return v as Obj;
}

function num(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}.${key}`, 'is not a number');
  return v;
}

function optNum(o: Obj, key: string, where: string): number | undefined {
  return o[key] === undefined ? undefined : num(o, key, where);
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`${where}.${key}`, 'is not a string');
  return v;
}

function optStr(o: Obj, key: string, where: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, where);
}

function bool(o: Obj, key: string, where: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail(`${where}.${key}`, 'is not a boolean');
  return v;
}

function arr(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail(`${where}.${key}`, 'is not an array');
  return v;
}

function box(v: unknown, where: string): VisionBox {
  const o = obj(v, where);
  const b = {
    x: num(o, 'x', where),
    y: num(o, 'y', where),
    width: num(o, 'width', where),
    height: num(o, 'height', where),
  };
  if (b.width < 0 || b.height < 0) fail(where, 'has a negative size');
  return b;
}

function optBox(o: Obj, key: string, where: string): VisionBox | undefined {
  return o[key] === undefined ? undefined : box(o[key], `${where}.${key}`);
}

function point(v: unknown, where: string): VisionPoint {
  const o = obj(v, where);
  return { x: num(o, 'x', where), y: num(o, 'y', where) };
}

/** Drop undefined keys so results compare cleanly and print without noise. */
function compact<T extends object>(o: T): T {
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return o;
}

function imageFields(o: Obj, where: string) {
  const width = num(o, 'width', where);
  const height = num(o, 'height', where);
  if (width <= 0 || height <= 0) fail(where, 'has an empty picture size');
  return {
    image: str(o, 'image', where),
    width,
    height,
    orientation: num(o, 'orientation', where),
    cached: bool(o, 'cached', where),
    ms: num(o, 'ms', where),
  };
}

function instance(v: unknown, where: string): VisionInstance {
  const o = obj(v, where);
  const index = num(o, 'index', where);
  if (!Number.isInteger(index) || index < 1)
    fail(`${where}.index`, 'is not an instance label (1…n)');
  return compact({
    index,
    bbox: box(o.bbox, `${where}.bbox`),
    area: num(o, 'area', where),
    pixels: num(o, 'pixels', where),
    center: point(o.center, `${where}.center`),
    maskPath: optStr(o, 'maskPath', where),
    cutoutPath: optStr(o, 'cutoutPath', where),
    cutoutBox: optBox(o, 'cutoutBox', where),
  });
}

function foreground(v: unknown, where: string): VisionForeground {
  const o = obj(v, where);
  return compact({
    bbox: box(o.bbox, `${where}.bbox`),
    area: num(o, 'area', where),
    pixels: num(o, 'pixels', where),
    center: point(o.center, `${where}.center`),
    maskPath: optStr(o, 'maskPath', where),
    cutoutPath: optStr(o, 'cutoutPath', where),
    cutoutBox: optBox(o, 'cutoutBox', where),
  });
}

export function parseVisionInfo(raw: unknown): VisionInfo {
  const where = 'info';
  const o = obj(raw, where);
  const cache = obj(o.cache, `${where}.cache`);
  return {
    version: num(o, 'version', where),
    os: str(o, 'os', where),
    lift: bool(o, 'lift', where),
    ocr: bool(o, 'ocr', where),
    ocrLanguages: arr(o, 'ocrLanguages', where).map((l, i) => {
      if (typeof l !== 'string') fail(`${where}.ocrLanguages[${i}]`, 'is not a string');
      return l;
    }),
    maxPixels: num(o, 'maxPixels', where),
    cache: {
      entries: num(cache, 'entries', `${where}.cache`),
      capacity: num(cache, 'capacity', `${where}.cache`),
    },
  };
}

export function parseVisionLift(raw: unknown): VisionLiftResult {
  const where = 'lift';
  const o = obj(raw, where);
  const instances = arr(o, 'instances', where).map((v, i) =>
    instance(v, `${where}.instances[${i}]`),
  );
  const count = num(o, 'count', where);
  if (count !== instances.length)
    fail(`${where}.count`, `is ${count} but ${instances.length} instances came back`);
  const result = compact({
    ...imageFields(o, where),
    count,
    analysisMs: num(o, 'analysisMs', where),
    instances,
    foreground:
      o.foreground === undefined ? undefined : foreground(o.foreground, `${where}.foreground`),
    labelsPath: optStr(o, 'labelsPath', where),
  });
  if (count > 0 && result.foreground === undefined) fail(`${where}.foreground`, 'is missing');
  return result;
}

export function parseVisionInstanceAt(raw: unknown): VisionInstanceAtResult {
  const where = 'instanceAt';
  const o = obj(raw, where);
  const index = num(o, 'index', where);
  const hit = bool(o, 'hit', where);
  const found = o.instance === undefined ? undefined : instance(o.instance, `${where}.instance`);
  if (hit !== (index !== 0)) fail(`${where}.hit`, `disagrees with index ${index}`);
  if (hit && found === undefined) fail(`${where}.instance`, 'is missing for a hit');
  if (found !== undefined && found.index !== index)
    fail(`${where}.instance.index`, `is not ${index}`);
  return compact({
    ...imageFields(o, where),
    count: num(o, 'count', where),
    analysisMs: num(o, 'analysisMs', where),
    point: point(o.point, `${where}.point`),
    index,
    hit,
    distance: optNum(o, 'distance', where),
    instance: found,
  });
}

function ocrLine(v: unknown, where: string): VisionOcrLine {
  const o = obj(v, where);
  const quad = arr(o, 'quad', where);
  if (quad.length !== 4) fail(`${where}.quad`, 'does not have 4 corners');
  const words =
    o.words === undefined
      ? undefined
      : arr(o, 'words', where).map((w, i): VisionOcrWord => {
          const wo = obj(w, `${where}.words[${i}]`);
          return compact({
            text: str(wo, 'text', `${where}.words[${i}]`),
            box: optBox(wo, 'box', `${where}.words[${i}]`),
          });
        });
  return compact({
    text: str(o, 'text', where),
    confidence: num(o, 'confidence', where),
    box: box(o.box, `${where}.box`),
    quad: [
      point(quad[0], `${where}.quad[0]`),
      point(quad[1], `${where}.quad[1]`),
      point(quad[2], `${where}.quad[2]`),
      point(quad[3], `${where}.quad[3]`),
    ] as const,
    words,
  });
}

export function parseVisionOcr(raw: unknown): VisionOcrResult {
  const where = 'ocr';
  const o = obj(raw, where);
  const level = str(o, 'level', where);
  if (level !== 'accurate' && level !== 'fast') fail(`${where}.level`, `is "${level}"`);
  return {
    ...imageFields(o, where),
    level,
    correction: bool(o, 'correction', where),
    revision: num(o, 'revision', where),
    text: str(o, 'text', where),
    lines: arr(o, 'lines', where).map((l, i) => ocrLine(l, `${where}.lines[${i}]`)),
  };
}

export function parseVisionWarm(raw: unknown): VisionWarmResult {
  const where = 'warm';
  const o = obj(raw, where);
  return {
    liftMs: num(o, 'liftMs', where),
    ocrMs: num(o, 'ocrMs', where),
    ms: num(o, 'ms', where),
    text: str(o, 'text', where),
  };
}

export function parseVisionForget(raw: unknown): VisionForgetResult {
  const where = 'forget';
  const o = obj(raw, where);
  return { dropped: num(o, 'dropped', where), entries: num(o, 'entries', where) };
}

// ── argument checks ──────────────────────────────────────────────────────────

function refuse(message: string): never {
  throw new VisionArgumentError(`pi-mac --vision: ${message}`);
}

function checkImage(image: unknown): void {
  if (typeof image !== 'string' || image.length === 0) refuse('image must be a file path');
  // The helper would resolve a relative path against ITS working directory,
  // which is nobody's intent.
  if (!path.isAbsolute(image)) refuse(`image must be an absolute path (got "${image}")`);
}

function checkFinite(value: unknown, name: string, { min }: { min?: number } = {}): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse(`${name} must be a number`);
  if (min !== undefined && value < min) refuse(`${name} must be at least ${min}`);
}

function checkWrite(write: readonly string[] | undefined, allowed: readonly string[]): void {
  if (write === undefined) return;
  const unknown = write.filter((w) => !allowed.includes(w));
  if (unknown.length > 0) {
    refuse(`unknown write option ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
}

function checkBox(b: VisionBox, name: string): void {
  checkFinite(b.x, `${name}.x`);
  checkFinite(b.y, `${name}.y`);
  checkFinite(b.width, `${name}.width`);
  checkFinite(b.height, `${name}.height`);
  if (b.width <= 0 || b.height <= 0) refuse(`${name} must have a positive size`);
}

/** Plain JSON for the wire: typed params minus undefined keys. */
function wire(params: object): Record<string, unknown> {
  return compact({ ...params } as Record<string, unknown>);
}

// ── the client ───────────────────────────────────────────────────────────────

export class MacVisionClient {
  readonly #helper: MacHelperClient;

  constructor(opts: MacVisionClientOptions = {}) {
    this.#helper = new MacHelperClient({
      helperPath: opts.helperPath,
      helperArgs: ['--vision-serve'],
      spawnFn: opts.spawnFn,
      requestTimeoutMs: opts.requestTimeoutMs ?? VISION_DEFAULT_TIMEOUT_MS,
      onStderr: opts.onStderr,
    });
  }

  /** What the helper can do; `version` must equal VISION_PROTOCOL_VERSION. */
  async info(): Promise<VisionInfo> {
    return parseVisionInfo(await this.#helper.request('info'));
  }

  /** Every foreground instance (and whatever files `write` asks for). */
  async lift(params: VisionLiftParams): Promise<VisionLiftResult> {
    checkImage(params.image);
    checkWrite(params.write, VISION_LIFT_OUTPUTS);
    if (params.instances !== undefined) {
      for (const i of params.instances) checkFinite(i, 'instances[]', { min: 1 });
    }
    return parseVisionLift(await this.#helper.request('lift', wire(params)));
  }

  /** The instance under a point (0 = background). */
  async instanceAt(params: VisionInstanceAtParams): Promise<VisionInstanceAtResult> {
    checkImage(params.image);
    checkFinite(params.x, 'x', { min: 0 });
    checkFinite(params.y, 'y', { min: 0 });
    if (params.radius !== undefined) checkFinite(params.radius, 'radius', { min: 0 });
    checkWrite(params.write, VISION_INSTANCE_OUTPUTS);
    return parseVisionInstanceAt(await this.#helper.request('instanceAt', wire(params)));
  }

  /** Text as lines (and words) with boxes, in reading order. */
  async ocr(params: VisionOcrParams): Promise<VisionOcrResult> {
    checkImage(params.image);
    const level: VisionOcrLevel | undefined = params.level;
    if (level !== undefined && level !== 'accurate' && level !== 'fast') {
      refuse(`level must be "accurate" or "fast" (got "${String(level)}")`);
    }
    if (params.minConfidence !== undefined) {
      checkFinite(params.minConfidence, 'minConfidence', { min: 0 });
      if (params.minConfidence > 1) refuse('minConfidence must be at most 1');
    }
    if (params.region !== undefined) checkBox(params.region, 'region');
    return parseVisionOcr(await this.#helper.request('ocr', wire(params)));
  }

  /** Pay the one-time model preparation now (~29 s on a new build, then ms). */
  async warm(): Promise<VisionWarmResult> {
    return parseVisionWarm(await this.#helper.request('warm'));
  }

  /** Drop the helper's cached analysis of one picture, or of all of them. */
  async forget(image?: string): Promise<VisionForgetResult> {
    if (image !== undefined) checkImage(image);
    return parseVisionForget(
      await this.#helper.request('forget', image === undefined ? {} : { image }),
    );
  }

  /** Stop the helper (it also exits by itself when this process goes away). */
  dispose(): void {
    this.#helper.dispose();
  }
}
