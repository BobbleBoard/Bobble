/**
 * The wire contract of `pi-mac --vision-serve` (Swift: swift/Sources/pi-mac/Vision.swift).
 *
 * Coordinates are IMAGE PIXELS with a TOP-LEFT origin, in the picture's
 * DISPLAYED orientation (EXIF orientation applied) — the space the editor's
 * canvas draws in. Masks are 8-bit single-channel PNGs at the picture's full
 * size (0 outside, 255 inside, soft at the edge); cutouts are RGBA PNGs in the
 * source's colour space that keep the original pixel values where opaque.
 */

/** Bumped by the helper when a result shape changes incompatibly. */
export const VISION_PROTOCOL_VERSION = 1;

export interface VisionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisionPoint {
  readonly x: number;
  readonly y: number;
}

/** One foreground object Vision separated from the rest of the picture. */
export interface VisionInstance {
  /** Vision's own label, 1…n (0 is background). Not ordered by position or
   * size — on the fixture row of apples, 1 is the RIGHTMOST. */
  readonly index: number;
  /** Pixels at least half covered by the mask. */
  readonly bbox: VisionBox;
  /** Fraction of the picture's pixels (0…1). */
  readonly area: number;
  readonly pixels: number;
  /** Centroid — not guaranteed to lie inside a concave shape. */
  readonly center: VisionPoint;
  readonly maskPath?: string;
  readonly cutoutPath?: string;
  /** Where a cropped cutout sits in the picture (soft edge included). */
  readonly cutoutBox?: VisionBox;
}

/** The union of the chosen instances — "remove background". */
export interface VisionForeground {
  readonly bbox: VisionBox;
  readonly area: number;
  readonly pixels: number;
  readonly center: VisionPoint;
  readonly maskPath?: string;
  readonly cutoutPath?: string;
  readonly cutoutBox?: VisionBox;
}

interface VisionImageResult {
  /** The picture as the helper resolved it (absolute). */
  readonly image: string;
  /** Displayed size (after EXIF orientation). */
  readonly width: number;
  readonly height: number;
  /** The EXIF orientation that was applied (1 = none). */
  readonly orientation: number;
  /** The analysis was already warm in the helper. */
  readonly cached: boolean;
  /** Wall time of this request inside the helper. */
  readonly ms: number;
}

export interface VisionLiftResult extends VisionImageResult {
  readonly count: number;
  /** Time the (possibly cached) instance analysis took when it ran. */
  readonly analysisMs: number;
  readonly instances: readonly VisionInstance[];
  /** Absent when nothing was found. */
  readonly foreground?: VisionForeground;
  /** 8-bit PNG whose value at each pixel is the instance index (0 = none). */
  readonly labelsPath?: string;
}

export interface VisionInstanceAtResult extends VisionImageResult {
  /** Instances in the whole picture. */
  readonly count: number;
  readonly analysisMs: number;
  readonly point: VisionPoint;
  /** 0 = background. */
  readonly index: number;
  readonly hit: boolean;
  /** How far the point was snapped (pixels), when `radius` found an instance. */
  readonly distance?: number;
  readonly instance?: VisionInstance;
}

export interface VisionOcrWord {
  readonly text: string;
  /** Absent when Vision could not place the word. */
  readonly box?: VisionBox;
}

export interface VisionOcrLine {
  readonly text: string;
  /** 0…1 (Vision reports coarse steps: 0.3, 0.5, 1). */
  readonly confidence: number;
  readonly box: VisionBox;
  /** top-left, top-right, bottom-right, bottom-left — tilted text stays exact. */
  readonly quad: readonly [VisionPoint, VisionPoint, VisionPoint, VisionPoint];
  readonly words?: readonly VisionOcrWord[];
}

export interface VisionOcrResult extends VisionImageResult {
  readonly level: VisionOcrLevel;
  readonly correction: boolean;
  /** VNRecognizeTextRequest revision that ran. */
  readonly revision: number;
  /** Every line, in reading order, joined with "\n". */
  readonly text: string;
  readonly lines: readonly VisionOcrLine[];
}

export interface VisionInfo {
  readonly version: number;
  readonly os: string;
  readonly lift: boolean;
  readonly ocr: boolean;
  readonly ocrLanguages: readonly string[];
  readonly maxPixels: number;
  readonly cache: {
    readonly entries: number;
    readonly capacity: number;
    /** What the cached analyses hold now, and the budget they are trimmed to. */
    readonly bytes?: number;
    readonly budgetBytes?: number;
  };
}

export interface VisionWarmResult {
  readonly liftMs: number;
  readonly ocrMs: number;
  readonly ms: number;
  /** What the warm-up picture read as ("Warm up"). */
  readonly text: string;
}

export interface VisionForgetResult {
  readonly dropped: number;
  readonly entries: number;
}

export type VisionOcrLevel = 'accurate' | 'fast';

/** Files `lift` can write. */
export type VisionLiftOutput = 'mask' | 'cutout' | 'foregroundMask' | 'foregroundCutout' | 'labels';
/** Files `instanceAt` can write. */
export type VisionInstanceOutput = 'mask' | 'cutout';

export const VISION_LIFT_OUTPUTS: readonly VisionLiftOutput[] = [
  'mask',
  'cutout',
  'foregroundMask',
  'foregroundCutout',
  'labels',
];
export const VISION_INSTANCE_OUTPUTS: readonly VisionInstanceOutput[] = ['mask', 'cutout'];

export interface VisionImageParams {
  /** Absolute path to a picture ImageIO can read (PNG, JPEG, HEIC, WebP…). */
  readonly image: string;
  /** Refuse pictures larger than this many pixels (default 64 M). */
  readonly maxPixels?: number;
}

export interface VisionOutputParams {
  /**
   * Folder for written files (default: the helper's temp folder). A file the
   * helper writes here always holds exactly what the response describes —
   * one edited in place is rewritten on the next request that names it, so
   * copy a mask into the document before refining it.
   */
  readonly out?: string;
  /** File-name prefix (default: "<picture name>-<content tag>"). */
  readonly prefix?: string;
  /** Crop cutouts to their soft-edged extent. */
  readonly crop?: boolean;
}

export interface VisionLiftParams extends VisionImageParams, VisionOutputParams {
  /** Only these instance indices (default: all). */
  readonly instances?: readonly number[];
  /** Default `['mask', 'foregroundMask']`; `[]` for numbers only. */
  readonly write?: readonly VisionLiftOutput[];
}

export interface VisionInstanceAtParams extends VisionImageParams, VisionOutputParams {
  readonly x: number;
  readonly y: number;
  /** Snap to the nearest instance within this many pixels (default 0; a tap
   * tolerance, capped at 1024). Image pixels: the canvas converts its screen
   * tolerance with the zoom it alone knows. */
  readonly radius?: number;
  /** Default `['mask']`; `[]` for numbers only. */
  readonly write?: readonly VisionInstanceOutput[];
}

export interface VisionOcrParams extends VisionImageParams {
  /** Default `'accurate'`; `'fast'` misreads display type (MEASURED). */
  readonly level?: VisionOcrLevel;
  /** Language correction (default true). A CHECK of painted text wants false. */
  readonly correction?: boolean;
  /** BCP-47 codes; default is automatic detection. */
  readonly languages?: readonly string[];
  readonly minConfidence?: number;
  /** Fraction of the picture's height. */
  readonly minTextHeight?: number;
  /** Per-word boxes (default true). */
  readonly words?: boolean;
  /** Read only this part of the picture (results stay in picture coordinates). */
  readonly region?: VisionBox;
}
