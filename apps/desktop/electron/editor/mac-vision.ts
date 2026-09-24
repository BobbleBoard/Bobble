/**
 * The image editor's MAC EXECUTOR for Apple Vision (MAC-01): the instance under
 * a tap, "remove background", every object in a picture, and OCR — through
 * `pi-mac --vision-serve` (packages/pi-mac/swift/Sources/pi-mac/Vision.swift).
 *
 * What the op router (ED-04) gets from here:
 *   - `segmentAt` → region proposals for a tap, first in the Mac's engine list
 *     for `image.segment` (studios doc §4.9: Vision → SAM 2.1 → SAM3 → disc).
 *     A miss returns no proposals, so the router falls through to the next
 *     engine; it is not an error.
 *   - `matte` → the whole foreground as a cutout ("Remove BG", instant).
 *   - `instances` → every object Vision found (hover outlines for Select).
 *   - `ocr` → lines and words with boxes (the poster OCR check, captions).
 *   - `warm` → pay the one-time model preparation of a new build (~29 s for
 *     accurate OCR, MEASURED) before a person waits on it.
 *
 * Coordinates are image pixels, top-left origin, DISPLAYED orientation.
 *
 * Electron-free on purpose (the unit tests run in plain Node): the caller
 * injects the helper path — mac-vision-main.ts resolves the bundled one. The
 * helper is started on first use and stopped after `idleMs` without a request;
 * it also exits on its own when this process goes away (its stdin closes), so
 * it cannot be orphaned. No permission is involved: Vision reads files.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MacVisionClient,
  VISION_PROTOCOL_VERSION,
  type VisionBox,
  type VisionForgetResult,
  type VisionInfo,
  type VisionInstanceAtResult,
  type VisionLiftResult,
  type VisionOcrParams,
  type VisionOcrResult,
  type VisionWarmResult,
} from '@pi-desktop/pi-mac';

/** The slice of MacVisionClient the executor drives (a fake in tests). */
export interface VisionClientLike {
  info(): Promise<VisionInfo>;
  lift(params: Parameters<MacVisionClient['lift']>[0]): Promise<VisionLiftResult>;
  instanceAt(params: Parameters<MacVisionClient['instanceAt']>[0]): Promise<VisionInstanceAtResult>;
  ocr(params: VisionOcrParams): Promise<VisionOcrResult>;
  warm(): Promise<VisionWarmResult>;
  forget(image?: string): Promise<VisionForgetResult>;
  dispose(): void;
}

export interface MacVisionExecutorOptions {
  /** The `pi-mac` binary (mac-vision-main.ts resolves the bundled one). */
  readonly helperPath: string;
  /** Where masks and cutouts go when an op names no folder. */
  readonly outDir?: string;
  /** Stop the helper after this long without a request. Default 90 s. */
  readonly idleMs?: number;
  /**
   * Largest picture the helper will analyse (pixels); unset = the helper's own
   * 64 MP default (MEASURED at 61 MP: 3.8 s, 2.4 GB peak). A larger picture is
   * refused with an error, and the router moves on to the next engine.
   */
  readonly maxPixels?: number;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: (file: string) => boolean;
  readonly createClient?: (helperPath: string) => VisionClientLike;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** One candidate region for a tap, as the region pipeline consumes it. */
export interface VisionRegionProposal {
  /** Stable per picture: `vision:instance:<n>` or `vision:foreground`. */
  readonly id: string;
  readonly engine: 'apple-vision';
  /** The tapped object, or every object together (for `]` = larger). */
  readonly kind: 'instance' | 'foreground';
  readonly instance?: number;
  readonly maskPath: string;
  readonly bbox: VisionBox;
  /** Fraction of the picture (0…1) — the router's 0.2%–60% default rule. */
  readonly area: number;
}

export interface VisionSegmentResult {
  readonly engine: 'apple-vision';
  readonly hit: boolean;
  /** 0 = background. */
  readonly index: number;
  /** Smallest first. Empty on a miss. */
  readonly proposals: readonly VisionRegionProposal[];
  readonly width: number;
  readonly height: number;
  /** Pixels the point was snapped by (only with a radius). */
  readonly distance?: number;
}

export interface VisionMatteResult {
  readonly engine: 'apple-vision';
  /** false = Vision saw no subject; fall through to BiRefNet. */
  readonly found: boolean;
  readonly width: number;
  readonly height: number;
  readonly cutoutPath?: string;
  readonly maskPath?: string;
  readonly bbox?: VisionBox;
  readonly area?: number;
  /** Where a cropped cutout sits in the picture. */
  readonly cutoutBox?: VisionBox;
}

const DEFAULT_IDLE_MS = 90_000;

export class MacVisionExecutor {
  readonly #helperPath: string;
  readonly #outDir: string;
  readonly #idleMs: number;
  readonly #maxPixels: number | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #fileExists: (file: string) => boolean;
  readonly #createClient: (helperPath: string) => VisionClientLike;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #client: VisionClientLike | null = null;
  #inFlight = 0;
  #idle: unknown = null;
  #compatible: Promise<boolean> | null = null;
  #disposed = false;

  constructor(opts: MacVisionExecutorOptions) {
    this.#helperPath = opts.helperPath;
    this.#outDir = opts.outDir ?? path.join(os.tmpdir(), 'bobble-vision');
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.#maxPixels = opts.maxPixels;
    this.#platform = opts.platform ?? process.platform;
    this.#fileExists = opts.fileExists ?? existsSync;
    this.#createClient = opts.createClient ?? ((helperPath) => new MacVisionClient({ helperPath }));
    this.#setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Can this Mac run the ops? macOS, the helper on disk, and a helper that
   * speaks this protocol version (asked once). Never throws: false means "use
   * the next engine".
   */
  available(): Promise<boolean> {
    if (this.#platform !== 'darwin' || !this.#fileExists(this.#helperPath)) {
      return Promise.resolve(false);
    }
    this.#compatible ??= this.#run((c) => c.info())
      .then((info) => info.version === VISION_PROTOCOL_VERSION && info.lift && info.ocr)
      .catch(() => {
        this.#compatible = null; // a transient failure may be retried later
        return false;
      });
    return this.#compatible;
  }

  /**
   * The object under a tap. `radius` is in IMAGE pixels — the canvas converts
   * its screen-space tolerance with the current zoom, which it alone knows.
   */
  async segmentAt(
    image: string,
    point: { readonly x: number; readonly y: number },
    opts: { readonly radius?: number; readonly outDir?: string } = {},
  ): Promise<VisionSegmentResult> {
    const out = opts.outDir ?? this.#outDir;
    const at = await this.#run((c) =>
      c.instanceAt({
        image,
        x: point.x,
        y: point.y,
        radius: opts.radius,
        out,
        write: ['mask'],
        maxPixels: this.#maxPixels,
      }),
    );
    const base = { engine: 'apple-vision' as const, width: at.width, height: at.height };
    if (!at.hit || at.instance === undefined || at.instance.maskPath === undefined) {
      return { ...base, hit: false, index: 0, proposals: [] };
    }
    const proposals: VisionRegionProposal[] = [
      {
        id: `vision:instance:${at.index}`,
        engine: 'apple-vision',
        kind: 'instance',
        instance: at.index,
        maskPath: at.instance.maskPath,
        bbox: at.instance.bbox,
        area: at.instance.area,
      },
    ];
    // With several objects, "everything" is the natural larger step for `]`.
    // The analysis is warm in the helper by now, so this costs a mask write.
    if (at.count > 1) {
      const all = await this.#run((c) =>
        c.lift({ image, out, write: ['foregroundMask'], maxPixels: this.#maxPixels }),
      );
      if (all.foreground?.maskPath !== undefined) {
        proposals.push({
          id: 'vision:foreground',
          engine: 'apple-vision',
          kind: 'foreground',
          maskPath: all.foreground.maskPath,
          bbox: all.foreground.bbox,
          area: all.foreground.area,
        });
      }
    }
    proposals.sort((a, b) => a.area - b.area);
    return {
      ...base,
      hit: true,
      index: at.index,
      proposals,
      ...(at.distance === undefined ? {} : { distance: at.distance }),
    };
  }

  /** The whole foreground as an RGBA cutout plus its mask. */
  async matte(
    image: string,
    opts: { readonly crop?: boolean; readonly outDir?: string } = {},
  ): Promise<VisionMatteResult> {
    const lift = await this.#run((c) =>
      c.lift({
        image,
        out: opts.outDir ?? this.#outDir,
        write: ['foregroundMask', 'foregroundCutout'],
        crop: opts.crop,
        maxPixels: this.#maxPixels,
      }),
    );
    const fg = lift.foreground;
    if (lift.count === 0 || fg === undefined) {
      return { engine: 'apple-vision', found: false, width: lift.width, height: lift.height };
    }
    return {
      engine: 'apple-vision',
      found: true,
      width: lift.width,
      height: lift.height,
      cutoutPath: fg.cutoutPath,
      maskPath: fg.maskPath,
      bbox: fg.bbox,
      area: fg.area,
      ...(fg.cutoutBox === undefined ? {} : { cutoutBox: fg.cutoutBox }),
    };
  }

  /** Every object, with a mask each (Select's hover outlines). */
  instances(image: string, opts: { readonly outDir?: string } = {}): Promise<VisionLiftResult> {
    return this.#run((c) =>
      c.lift({
        image,
        out: opts.outDir ?? this.#outDir,
        write: ['mask', 'labels'],
        maxPixels: this.#maxPixels,
      }),
    );
  }

  /** Text with boxes. A CHECK of painted text wants `correction: false`. */
  ocr(image: string, opts: Omit<VisionOcrParams, 'image'> = {}): Promise<VisionOcrResult> {
    return this.#run((c) => c.ocr({ maxPixels: this.#maxPixels, ...opts, image }));
  }

  /** Pay the one-time model preparation now (a background moment is best). */
  warm(): Promise<VisionWarmResult> {
    return this.#run((c) => c.warm());
  }

  /** Forget a picture's cached analysis (it was edited in place, say). */
  async forget(image?: string): Promise<void> {
    if (this.#client === null) return; // nothing is cached in a stopped helper
    await this.#run((c) => c.forget(image));
  }

  /** Stop the helper; later calls start a fresh one unless disposed for good. */
  stop(): void {
    this.#cancelIdle();
    this.#client?.dispose();
    this.#client = null;
  }

  /** Stop for good (app quit). */
  dispose(): void {
    this.#disposed = true;
    this.stop();
  }

  /** Whether a helper process is currently up (tests, diagnostics). */
  get running(): boolean {
    return this.#client !== null;
  }

  async #run<T>(op: (client: VisionClientLike) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error('mac-vision: the executor was disposed');
    this.#cancelIdle();
    this.#client ??= this.#createClient(this.#helperPath);
    const client = this.#client;
    this.#inFlight++;
    try {
      return await op(client);
    } finally {
      this.#inFlight--;
      if (this.#inFlight === 0) this.#armIdle();
    }
  }

  #armIdle(): void {
    this.#cancelIdle();
    if (this.#client === null) return;
    this.#idle = this.#setTimer(() => {
      this.#idle = null;
      if (this.#inFlight === 0) this.stop();
    }, this.#idleMs);
  }

  #cancelIdle(): void {
    if (this.#idle !== null) this.#clearTimer(this.#idle);
    this.#idle = null;
  }
}
