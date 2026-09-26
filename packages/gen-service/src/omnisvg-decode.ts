/**
 * OmniSVG TOKEN IDS → SVG TEXT, in TypeScript.
 *
 * OmniSVG does not emit SVG as text. It is a Qwen2.5-VL fine-tune whose
 * vocabulary was grown from 151,936 to 197,000 entries, and everything it
 * generates lives in that upper range: command tokens (move/line/curve/arc/
 * close), coordinate tokens (one per cell of a 200×200 grid), arc parameters,
 * and colour tokens (a 12-bit RGB palette). Their reference decoder is
 * `tokenizer.py` + the vendored `deepsvg` — Python, torch, numpy.
 *
 * This is that decoder, ported so the connector needs no Python at runtime:
 * the model runs as a GGUF under the app's own llama-server, the server hands
 * back token ids (`return_tokens`), and this turns them into a file. It is a
 * pure function of the ids and is checked against fixtures their decoder
 * produced from the same ids (see the test) — same commands, same coordinates,
 * same colours, same text.
 *
 * Constants are the "4B" profile of their config.yaml, with the derivations
 * from `SVGTokenizer._load_config` written out rather than re-derived at
 * runtime, so a reader can check each number against the file.
 */

/** One OmniSVG model's token layout (config.yaml's per-size block + the shared ones). */
export interface OmniSvgVariant {
  readonly baseOffset: number;
  readonly numMaskAndEom: number;
  readonly numSvgEnd: number;
  readonly pixPad: number;
  readonly coordPad: number;
  readonly bbox: number;
  readonly colorTokenStartRaw: number;
  readonly maxColorTokens: number;
  readonly arcParamOffset: number;
  readonly arcParamRange: number;
  readonly bos: number;
  readonly eos: number;
  readonly cmd: {
    readonly move: number;
    readonly line: number;
    readonly curve: number;
    readonly arc: number;
    readonly close: number;
  };
}

/** OmniSVG1.1_4B — every value from config.yaml's `4B` block + shared blocks. */
export const OMNISVG_4B: OmniSvgVariant = {
  baseOffset: 151_936, // tokens.base_offset
  numMaskAndEom: 151_938, // tokens.num_mask_and_eom
  numSvgEnd: 1, // tokens.svg_end
  pixPad: 151_943, // coordinates.pix_pad_offset
  coordPad: 151_943, // coordinates.coord_pad_offset
  bbox: 200, // coordinates.bbox
  colorTokenStartRaw: 40_010, // colors.color_token_start
  maxColorTokens: 4_098, // colors.max_color_tokens
  arcParamOffset: 44_500, // arc.param_offset
  arcParamRange: 100, // arc.param_range
  bos: 196_998, // model.bos_token_id
  eos: 196_999, // model.eos_token_id
  cmd: { move: -5, line: -4, curve: -3, arc: -2, close: -1 }, // svg_commands
};

/**
 * OmniSVG1.1_8B — config.yaml's `8B` block: the same grown vocabulary on Qwen
 * 2.5-VL-7B's larger base (152,064), so every SVG token sits 128 ids higher.
 * Decoding its output with the 4B's offsets reads every coordinate wrong.
 */
export const OMNISVG_8B: OmniSvgVariant = {
  ...OMNISVG_4B,
  baseOffset: 152_064, // tokens.base_offset
  numMaskAndEom: 152_066, // tokens.num_mask_and_eom
  pixPad: 152_071, // coordinates.pix_pad_offset
  coordPad: 152_071, // coordinates.coord_pad_offset
};

/** The derived constants, exactly as `_load_config` computes them. */
function derived(c: OmniSvgVariant) {
  const pixelOffset = c.numMaskAndEom - c.baseOffset + c.numSvgEnd - c.cmd.move; // 8
  return {
    pixelOffset,
    cmdTokenStart: c.numMaskAndEom + c.numSvgEnd, // 151939
    cmdTokenEnd: c.pixPad + c.numSvgEnd, // 151944
    coordTokenStart: c.pixPad + c.numSvgEnd, // 151944
    colorCoordBoundary: c.colorTokenStartRaw + 1 + c.baseOffset, // 191947
    arcParamStart: c.arcParamOffset + c.baseOffset, // 196436
    colorThreshold: c.colorTokenStartRaw - pixelOffset + 1, // 40003
  };
}

/** A colour token → CSS colour, as `token_to_color`. 12-bit RGB, each nibble doubled. */
export function colorFromToken(colorToken: number, c: OmniSvgVariant = OMNISVG_4B): string {
  if (colorToken === c.colorTokenStartRaw) return 'none';
  if (colorToken === c.colorTokenStartRaw + 1) return 'currentColor';
  const index = colorToken - (c.colorTokenStartRaw + 2);
  if (index < 0 || index >= c.maxColorTokens) return '#808080';
  const r = (index >> 8) & 0xf;
  const g = (index >> 4) & 0xf;
  const b = index & 0xf;
  const hex = (n: number) => ((n << 4) | n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Step 1 — `process_generated_tokens`: each id becomes an (x, y) pair by which
 * range it falls in. Anything outside every range is dropped, as theirs does.
 */
export function tokensToXY(
  ids: readonly number[],
  c: OmniSvgVariant = OMNISVG_4B,
): Array<[number, number]> {
  const D = derived(c);
  const out: Array<[number, number]> = [];
  for (const t of ids) {
    if (t >= D.cmdTokenStart && t < D.cmdTokenEnd) {
      out.push([t - c.baseOffset, t - c.baseOffset]);
    } else if (t >= D.coordTokenStart && t < D.colorCoordBoundary) {
      const pixel = t - D.coordTokenStart;
      if (pixel >= 0 && pixel < c.bbox * c.bbox) {
        // pixel2xy: meshgrid ravel order is row-major, so x = i % bbox, y = i / bbox.
        const x = pixel % c.bbox;
        const y = Math.floor(pixel / c.bbox);
        const pad = c.coordPad + c.numSvgEnd - c.baseOffset;
        out.push([x + pad, y + pad]);
      }
    } else if (t >= D.arcParamStart + 1 && t < D.arcParamStart + 1 + c.arcParamRange) {
      const v = t - D.arcParamStart - 1;
      out.push([v, v]);
    } else if (t >= D.colorCoordBoundary && t < D.arcParamStart) {
      out.push([t - c.baseOffset, t - c.baseOffset]);
    }
  }
  return out;
}

/** One decoded path: its commands as SVG `d` text, and its fill colour. */
export interface DecodedPath {
  readonly d: string;
  readonly fill: string;
}

const f1 = (n: number): string => n.toFixed(1);

/**
 * Step 2 — `raster_svg` + deepsvg's `SVGPath.from_commands` + `to_str`.
 *
 * The pairs are walked as a command stream: a move consumes 3 slots (their
 * decoder ignores the middle one too), a line 2, a curve 4, an arc 6, a close
 * 2; a colour token ends the current `<path>` and names its fill.
 *
 * Sub-path assembly follows deepsvg exactly, quirks included, because the
 * golden fixtures — and every SVG OmniSVG has ever produced — went through it:
 *
 *   - a move that left an empty sub-path is discarded by the next move;
 *   - the `M` point is the move's end (deepsvg fills each row's start from the
 *     previous row's end, and prints the first real command's start);
 *   - a close ALWAYS writes `L<end>` before `Z`. Their `start_pos != end_pos`
 *     guard compares `Point` objects that define no `__eq__`, so it is an
 *     identity test and never false. Harmless (a line to where the pen already
 *     is), but it is in the output, so it is here;
 *   - after a close, every command until the next move is dropped.
 */
export function xyToPaths(
  pairs: ReadonlyArray<readonly [number, number]>,
  c: OmniSvgVariant = OMNISVG_4B,
): DecodedPath[] {
  const D = derived(c);
  const px = pairs.map(([x, y]) => [x - D.pixelOffset, y - D.pixelOffset] as const);
  const paths: DecodedPath[] = [];
  /** Sub-paths finished (by a move or a close) since the last colour. */
  let done: string[] = [];
  /** The sub-path being built: its M point, its commands, or null after a close. */
  let cur: { m: readonly [number, number]; cmds: string[] } | null = null;

  const pushCur = (closed: boolean) => {
    if (cur !== null && cur.cmds.length > 0) {
      done.push(`M${f1(cur.m[0])} ${f1(cur.m[1])} ${cur.cmds.join(' ')}${closed ? ' Z' : ''}`);
    }
    cur = null;
  };
  const flush = (fill: string) => {
    pushCur(false);
    if (done.length > 0) paths.push({ d: done.join(' '), fill });
    done = [];
  };
  const at = (i: number): readonly [number, number] => px[i] as readonly [number, number];

  let i = 0;
  while (i < px.length) {
    const head = px[i]?.[0];
    if (head === undefined) break;
    if (head === c.cmd.move) {
      if (i + 2 >= px.length) break;
      pushCur(false); // an empty one simply vanishes here, as theirs does
      cur = { m: at(i + 2), cmds: [] };
      i += 3;
    } else if (head === c.cmd.line) {
      if (i + 1 >= px.length) break;
      const [x, y] = at(i + 1);
      cur?.cmds.push(`L${f1(x)} ${f1(y)}`);
      i += 2;
    } else if (head === c.cmd.curve) {
      if (i + 3 >= px.length) break;
      const [a, b] = at(i + 1);
      const [cx, cy] = at(i + 2);
      const [x, y] = at(i + 3);
      cur?.cmds.push(`C${f1(a)} ${f1(b)} ${f1(cx)} ${f1(cy)} ${f1(x)} ${f1(y)}`);
      i += 4;
    } else if (head === c.cmd.arc) {
      if (i + 5 >= px.length) break;
      const [rx, ry] = at(i + 1);
      const rot = at(i + 2)[0] + D.pixelOffset;
      const large = at(i + 3)[0] + D.pixelOffset;
      const sweep = at(i + 4)[0] + D.pixelOffset;
      const [x, y] = at(i + 5);
      cur?.cmds.push(`A${f1(rx)} ${f1(ry)} ${f1(rot)} ${large} ${sweep} ${f1(x)} ${f1(y)}`);
      i += 6;
    } else if (head === c.cmd.close) {
      if (i + 1 >= px.length) break;
      if (cur !== null && cur.cmds.length > 0) {
        const [x, y] = at(i + 1);
        cur.cmds.push(`L${f1(x)} ${f1(y)}`);
        pushCur(true);
      }
      cur = null; // and nothing lands until the next move
      i += 2;
    } else if (head >= D.colorThreshold) {
      // Reverse transform, as theirs: the raw colour token is pix + offset - 1.
      flush(colorFromToken(head + D.pixelOffset - 1, c));
      i += 1;
    } else {
      i += 1;
    }
  }
  flush('none');
  return paths;
}

/** The whole file, formatted the way their `SVG.to_str()` writes it. */
export function pathsToSvg(paths: readonly DecodedPath[], c: OmniSvgVariant = OMNISVG_4B): string {
  const body = paths
    .map((p) => `<path fill="${p.fill}" fill-opacity="1.0"  filling="0" d="${p.d}"></path>`)
    .join('');
  const b = f1(c.bbox);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.0 0.0 ${b} ${b}" height="${c.bbox}px" width="${c.bbox}px">${body}</svg>`;
}

/**
 * Ids straight from llama-server → SVG text, or null when nothing decodable
 * came out. Cuts at the first EOS and ignores a leading BOS, so the raw
 * `tokens` array of a `/completion` response can be passed as-is.
 */
export function decodeOmniSvg(
  ids: readonly number[],
  c: OmniSvgVariant = OMNISVG_4B,
): { svg: string; paths: number; extent: Extent | null } | null {
  const body: number[] = [];
  for (const t of ids) {
    if (t === c.eos) break;
    if (t === c.bos) continue;
    body.push(t);
  }
  const paths = xyToPaths(tokensToXY(body, c), c);
  if (paths.length === 0) return null;
  return { svg: pathsToSvg(paths, c), paths: paths.length, extent: pathsExtent(paths, c.bbox) };
}

/** Where a drawing lies on its canvas, each edge as a fraction of the side (0 = left/top). */
export interface Extent {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The box every point of the paths falls in — ends and control points of
 * lines, curves and arcs (an arc's radii and flags are not points).
 */
export function pathsExtent(paths: readonly DecodedPath[], side: number): Extent | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const see = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of paths) {
    // A white shape on the white ground draws nothing a person sees — MEASURED,
    // a one-path white square "covered" the robot it failed to draw.
    if (nearWhite(p.fill)) continue;
    for (const m of p.d.matchAll(/([MLCAZ])([^MLCAZ]*)/g)) {
      const n = (m[2] ?? '')
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (m[1] === 'A') {
        for (let k = 0; k + 6 < n.length; k += 7)
          see(n[k + 5] ?? Number.NaN, n[k + 6] ?? Number.NaN);
      } else {
        for (let k = 0; k + 1 < n.length; k += 2) see(n[k] ?? Number.NaN, n[k + 1] ?? Number.NaN);
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  const f = (v: number) => Math.max(0, Math.min(1, v / side));
  return { x0: f(x0), y0: f(y0), x1: f(x1), y1: f(y1) };
}

/** #rrggbb lighter than about 93% — invisible on white. */
function nearWhite(fill: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(fill.trim());
  if (m === null) return false;
  const n = Number.parseInt(m[1] ?? '', 16);
  return Math.min((n >> 16) & 255, (n >> 8) & 255, n & 255) >= 238;
}

const area = (e: Extent): number => Math.max(0, e.x1 - e.x0) * Math.max(0, e.y1 - e.y0);

/**
 * HOW GOOD A CANDIDATE LOOKS, BEFORE ANYONE SEES IT — higher is better.
 *
 * MEASURED (the authors' own examples, 4B, three candidates each): "finished
 * first, then the most paths" kept a 24-path scrap in one corner over a clean
 * crescent moon, and would keep a three-path blob that stopped on eos over a
 * near-complete drawing cut at the limit. So a drawing is scored by how much
 * of the picture it covers: for a traced picture, the overlap of its extent
 * with where the picture has ink (`target`); for a prompt, how much of the
 * canvas it fills (a third or more is a whole drawing). Finishing on eos is
 * worth a quarter — it breaks near ties, it does not rescue a scrap.
 */
export function pickScore(
  cand: { readonly stop: string; readonly extent: Extent | null },
  target?: Extent | null,
): number {
  const e = cand.extent;
  let fit = 0;
  if (e !== null) {
    if (target !== undefined && target !== null) {
      const ix = Math.max(0, Math.min(e.x1, target.x1) - Math.max(e.x0, target.x0));
      const iy = Math.max(0, Math.min(e.y1, target.y1) - Math.max(e.y0, target.y0));
      const inter = ix * iy;
      const union = area(e) + area(target) - inter;
      fit = union > 0 ? inter / union : 0;
    } else {
      fit = Math.min(1, area(e) / 0.33);
    }
  }
  return fit + (cand.stop === 'eos' ? 0.25 : 0);
}

/**
 * WHERE A RUNAWAY LOOP BEGINS in a stream of ids, or -1.
 *
 * MEASURED (2026-09-25, the authors' prompts through the app's pipeline): a
 * quarter to a half of the samples spend the whole 1,536-token budget on one
 * command repeated — `C40 188 40 188 40 188`, 320 times over, a curve of no
 * length — and stop at the limit with the drawing unfinished. Exactly the same
 * ids over and over is never a drawing (the same point, the same curve, again
 * and again), so the tail is checked for a block of up to `maxPeriod` ids
 * repeated `minRepeats` times back to back. The answer is where the FIRST copy
 * of the block starts: everything before it is the drawing, kept.
 */
export function loopStart(
  ids: readonly number[],
  { maxPeriod = 24, minRepeats = 12 }: { maxPeriod?: number; minRepeats?: number } = {},
): number {
  const n = ids.length;
  let start = -1;
  for (let p = 1; p <= maxPeriod && p * minRepeats <= n; p++) {
    // How far back from the end each id equals the one a period before it.
    let run = 0;
    while (run < n - p && ids[n - 1 - run] === ids[n - 1 - run - p]) run++;
    if (run >= p * (minRepeats - 1)) {
      const first = n - run - p;
      if (start === -1 || first < start) start = first;
    }
  }
  return start;
}

/**
 * The drawing SO FAR, from a prefix of the ids — for the card that shows the
 * model drawing while it draws.
 *
 * The colour of a shape arrives AFTER its commands in this vocabulary, so the
 * shape being drawn has no fill yet and `xyToPaths` flushes it with `none`,
 * which is invisible. Here the unfinished shape is shown as the pen would show
 * it: an outline, so the eye sees where the line is going before the colour
 * lands. Every finished shape is exactly what the final file will have.
 */
export function decodeOmniSvgPartial(
  ids: readonly number[],
  c: OmniSvgVariant = OMNISVG_4B,
): { svg: string; paths: number; drawing: boolean } | null {
  const body: number[] = [];
  for (const t of ids) {
    if (t === c.eos) break;
    if (t === c.bos) continue;
    body.push(t);
  }
  const paths = xyToPaths(tokensToXY(body, c), c);
  if (paths.length === 0) return null;
  const last = paths[paths.length - 1];
  const drawing = last !== undefined && last.fill === 'none';
  const finished = drawing ? paths.slice(0, -1) : paths;
  const pen =
    drawing && last !== undefined
      ? `<path fill="none" stroke="#7a8190" stroke-opacity="0.8" stroke-width="1.2" ` +
        `stroke-linejoin="round" stroke-linecap="round" d="${last.d}"></path>`
      : '';
  const svg = pathsToSvg(finished, c).replace('</svg>', `${pen}</svg>`);
  return { svg, paths: finished.length, drawing };
}
