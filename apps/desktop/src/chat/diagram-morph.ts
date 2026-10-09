/**
 * A DIAGRAM THAT MOVES INTO ITS NEXT FRAME.
 *
 * The user (2026-09-25): "ensure those animate/build in real time smoothly". A
 * live diagram card is a run of whole drawings from main, each a fresh
 * Mermaid layout of a few more lines (electron/gen/diagram-live.ts). Swapped
 * in as they come, every frame jumps: a step lands, the others shift under
 * the reader's eye, the card snaps taller. So a new frame goes in and every
 * part of it starts from where it was on screen a moment ago:
 *
 *   - a part in both frames — matched by its `data-k`, the key the page's
 *     post-pass gives every step, edge, label and group (diagram-page.ts) —
 *     GLIDES to its new place: a step, a label, a word by its transform (its
 *     old box on screen mapped into its new parent's space: FLIP), a group's
 *     box and a line by their own geometry, an edge by its points (the old
 *     and the new path resampled to the same count, so one bends into the
 *     other), a colour that changed (a step that was the last, and is no
 *     longer) by its colour;
 *   - a new part FADES and SCALES in; a new edge DRAWS itself from its start,
 *     its arrowhead landing when the line does;
 *   - a part that is gone FADES OUT where it was;
 *   - the card's height follows, so it grows instead of snapping.
 *
 * ~200 ms each, eased out, on requestAnimationFrame, and only while something
 * is moving. A frame that arrives mid-move starts from where things ARE —
 * half-faded, half-drawn, half-way — so there is never a jump between two
 * animations. Reduced motion: the new frame, in place, at once.
 *
 * The maths is pure and exported (flattenPath, resample, mixColor…, tested in
 * diagram-morph.test.ts); DiagramMorph is the DOM half.
 */

export type Pt = readonly [number, number];

// ── the maths ────────────────────────────────────────────────────────────────

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const ARGS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, Z: 0 };

/**
 * The points along a path — lines as their ends, curves sampled — in its own
 * coordinates. M L H V C Q Z, absolute or relative (what Mermaid and the
 * post-pass write for an edge); null for anything else.
 */
export function flattenPath(d: string, samples = 8): Pt[] | null {
  if (/[AaSsTt]/.test(d)) return null;
  const out: Pt[] = [];
  const re = /([MLHVCQZmlhvcqz])([^MLHVCQZmlhvcqz]*)/g;
  let x = 0;
  let y = 0;
  let x0 = 0;
  let y0 = 0;
  for (let m = re.exec(d); m !== null; m = re.exec(d)) {
    const c = m[1] ?? '';
    const C = c.toUpperCase();
    const rel = c !== C;
    const size = ARGS[C] ?? 0;
    if (C === 'Z') {
      x = x0;
      y = y0;
      out.push([x, y]);
      continue;
    }
    const n = (m[2]?.match(NUM) ?? []).map(Number);
    for (let i = 0; i + size <= n.length; i += size) {
      const v = (k: number): number => n[i + k] ?? 0;
      if (C === 'H') {
        x = rel ? x + v(0) : v(0);
        out.push([x, y]);
        continue;
      }
      if (C === 'V') {
        y = rel ? y + v(0) : v(0);
        out.push([x, y]);
        continue;
      }
      const px = (k: number): number => (rel ? x + v(k) : v(k));
      const py = (k: number): number => (rel ? y + v(k + 1) : v(k + 1));
      if (C === 'M' || C === 'L') {
        x = px(0);
        y = py(0);
        if (C === 'M' && i === 0) {
          x0 = x;
          y0 = y;
        }
        out.push([x, y]);
        continue;
      }
      if (C === 'C') {
        const [ax, ay, bx, by, ex, ey] = [px(0), py(0), px(2), py(2), px(4), py(4)];
        for (let s = 1; s <= samples; s += 1) {
          const t = s / samples;
          const u = 1 - t;
          out.push([
            u * u * u * x + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex,
            u * u * u * y + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey,
          ]);
        }
        x = ex;
        y = ey;
        continue;
      }
      // Q
      const [ax, ay, ex, ey] = [px(0), py(0), px(2), py(2)];
      for (let s = 1; s <= samples; s += 1) {
        const t = s / samples;
        const u = 1 - t;
        out.push([
          u * u * x + 2 * u * t * ax + t * t * ex,
          u * u * y + 2 * u * t * ay + t * t * ey,
        ]);
      }
      x = ex;
      y = ey;
    }
  }
  return out.length >= 2 ? out : null;
}

/** The length of a polyline. */
export function lengthOf(points: readonly Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Pt;
    const b = points[i] as Pt;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

/** `n` points spaced evenly along a polyline, its ends kept. */
export function resample(points: readonly Pt[], n: number): Pt[] {
  if (points.length === 0) return [];
  if (points.length === 1 || n < 2)
    return Array.from({ length: Math.max(1, n) }, () => points[0] as Pt);
  const total = lengthOf(points);
  if (total === 0) return Array.from({ length: n }, () => points[0] as Pt);
  const out: Pt[] = [points[0] as Pt];
  let seg = 1;
  let walked = 0;
  for (let k = 1; k < n - 1; k += 1) {
    const at = (total * k) / (n - 1);
    while (seg < points.length - 1) {
      const a = points[seg - 1] as Pt;
      const b = points[seg] as Pt;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (walked + len >= at) break;
      walked += len;
      seg += 1;
    }
    const a = points[seg - 1] as Pt;
    const b = points[seg] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, (at - walked) / len));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  out.push(points[points.length - 1] as Pt);
  return out;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mixPoints(a: readonly Pt[], b: readonly Pt[], t: number): Pt[] {
  return a.map((p, i) => {
    const q = b[i] ?? p;
    return [mix(p[0], q[0], t), mix(p[1], q[1], t)] as Pt;
  });
}

/** Path data for a polyline, to a hundredth. */
export function polyline(points: readonly Pt[]): string {
  const f = (v: number): string => String(Math.round(v * 100) / 100);
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p[0])},${f(p[1])}`).join('');
}

/** #RGB, #RRGGBB or rgb()/rgba() → [r, g, b], else null. */
export function parseColor(c: string | null | undefined): [number, number, number] | null {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short !== null)
    return [1, 2, 3].map((i) => Number.parseInt(`${short[i]}${short[i]}`, 16)) as [
      number,
      number,
      number,
    ];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (long !== null)
    return [1, 2, 3].map((i) => Number.parseInt(long[i] ?? '0', 16)) as [number, number, number];
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn !== null) {
    const p = (fn[1] ?? '').split(',').map((v) => Number.parseFloat(v));
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite))
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  }
  return null;
}

/** Two colours mixed, as #RRGGBB; `b` when either is not a colour. */
export function mixColor(a: string, b: string, t: number): string {
  const p = parseColor(a);
  const q = parseColor(b);
  if (p === null || q === null) return b;
  const h = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(mix(p[0], q[0], t))}${h(mix(p[1], q[1], t))}${h(mix(p[2], q[2], t))}`.toUpperCase();
}

/** Eased out — quick to leave, soft to land (the app's cubic-bezier(0.2, 0.8, 0.2, 1), near enough). */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/** Which keys stayed, which came, which went. */
export function diffKeys(
  before: readonly string[],
  after: readonly string[],
): { kept: string[]; added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    kept: after.filter((k) => was.has(k)),
    added: after.filter((k) => !was.has(k)),
    removed: before.filter((k) => !now.has(k)),
  };
}

/**
 * What a part's key says it is: an edge draws, a step pops, a word fades —
 * after the steps and edges it names; the card's title first of all.
 */
export function roleOfKey(
  key: string,
): 'head' | 'edge' | 'line' | 'step' | 'label' | 'group' | 'other' {
  if (/^head:/.test(key)) return 'head';
  if (/^(?:e|m):/.test(key)) return 'edge';
  if (/^(?:al|lp):/.test(key) && /:line:|^al:/.test(key)) return 'line';
  if (/^(?:n|a):/.test(key)) return 'step';
  if (/^(?:l|mt|t):|:name$|:text/.test(key)) return 'label';
  if (/^(?:c|no|lp|act):/.test(key)) return 'group';
  return 'other';
}

// ── the DOM ──────────────────────────────────────────────────────────────────

/** How long each kind of move takes, and when it starts after a frame lands. */
const TIMING = {
  glide: { dur: 210, delay: 0 },
  step: { dur: 200, delay: 0, stagger: 35, most: 140 },
  edge: { dur: 240, delay: 70, stagger: 35, most: 160 },
  label: { dur: 180, delay: 140, stagger: 25, most: 120 },
  leave: { dur: 150, delay: 0 },
  grow: { dur: 220, delay: 0 },
} as const;

/** Points an edge is resampled to while it bends into its new shape. */
const BEND_POINTS = 40;

type SvgEl = SVGGraphicsElement;

/** A part of the frame on screen, as it was just before the next one went in. */
interface Before {
  readonly key: string;
  readonly el: SvgEl;
  readonly tag: string;
  readonly box: DOMRect;
  readonly parent: DOMMatrix | null;
  readonly rect?: readonly [number, number, number, number];
  readonly line?: readonly [Pt, Pt];
  readonly points?: readonly Pt[];
  readonly paints: readonly string[];
  /** How far in it was (1 = fully there): a part mid-entrance continues from here. */
  readonly shown: number;
}

type Tween = {
  readonly el: Element;
  readonly start: number;
  readonly dur: number;
  /** Set the state at eased progress e (0 → 1). */
  readonly apply: (e: number) => void;
  /** Put the element back as the frame drew it. */
  readonly done: () => void;
};

/** Numeric attributes moved from one set of values to another. */
function attrTween(
  el: Element,
  names: readonly string[],
  from: readonly number[],
  to: readonly number[],
  start: number,
  dur: number,
): Tween {
  const put = (value: (i: number) => number): void => {
    for (let i = 0; i < names.length; i += 1) el.setAttribute(names[i] ?? '', String(value(i)));
  };
  return {
    el,
    start,
    dur,
    apply: (e) => put((i) => mix(from[i] ?? 0, to[i] ?? 0, e)),
    done: () => put((i) => to[i] ?? 0),
  };
}

function screenOf(el: SvgEl): DOMMatrix | null {
  try {
    return el.getScreenCTM() as DOMMatrix | null;
  } catch {
    return null;
  }
}

function at(m: DOMMatrix, x: number, y: number): Pt {
  const p = new DOMPoint(x, y).matrixTransform(m);
  return [p.x, p.y];
}

const num = (el: Element, a: string): number => Number.parseFloat(el.getAttribute(a) ?? '0') || 0;

/** The fill and stroke of a part and all inside it, in order — what a colour change is read from. */
function paintsOf(el: Element): string[] {
  const out: string[] = [];
  for (const x of [el, ...el.querySelectorAll('*')]) {
    out.push(`${x.tagName}|${x.getAttribute('fill') ?? ''}|${x.getAttribute('stroke') ?? ''}`);
  }
  return out;
}

/** The parts of a drawing: every keyed element not inside another. */
function partsOf(svg: SVGSVGElement): Map<string, SvgEl> {
  const out = new Map<string, SvgEl>();
  for (const el of svg.querySelectorAll<SvgEl>('[data-k]')) {
    if (el.parentElement?.closest('[data-k]') != null) continue;
    if (el.closest('[data-pd-ghosts]') !== null) continue;
    const key = el.getAttribute('data-k') ?? '';
    if (key !== '' && !out.has(key)) out.set(key, el);
  }
  return out;
}

export interface DiagramMorphOptions {
  /** Every frame is put through this before it touches the document (the svg surface's DOMPurify). */
  readonly sanitize: (markup: string) => string;
  /** Whether to move at all (prefers-reduced-motion). */
  readonly reducedMotion?: () => boolean;
}

/** The DOM half: a host element whose one SVG moves into each new frame it is shown. */
export class DiagramMorph {
  private readonly host: HTMLElement;
  private readonly opts: DiagramMorphOptions;
  private tweens: Tween[] = [];
  private frame = 0;
  private markup = '';
  /** Entrance progress of the parts still coming in (0 → 1), read when a frame lands mid-way. */
  private readonly entering = new WeakMap<Element, () => number>();

  constructor(host: HTMLElement, opts: DiagramMorphOptions) {
    this.host = host;
    this.opts = opts;
  }

  /** Whether anything is still moving. */
  get moving(): boolean {
    return this.tweens.length > 0;
  }

  /** The frame on screen now (as given, before sanitising). */
  get shown(): string {
    return this.markup;
  }

  /**
   * Show `markup`. With `animate`, every part moves from where it is on screen
   * now — into an empty host, everything builds in; without (or with reduced
   * motion), it is simply there.
   */
  show(markup: string, animate: boolean): void {
    if (markup === this.markup) return;
    const next = this.parse(markup);
    if (next === null) return;
    this.markup = markup;
    const current = this.host.querySelector(':scope > svg') as SVGSVGElement | null;
    const still = !animate || (this.opts.reducedMotion?.() ?? false);
    if (still) {
      this.stop(true);
      this.host.replaceChildren(next);
      this.host.style.height = '';
      this.host.style.overflowY = '';
      return;
    }
    const t0 = performance.now();
    const before = current !== null ? this.capture(current) : new Map<string, Before>();
    const hostBefore = this.host.getBoundingClientRect().height;
    this.stop(false);
    this.host.style.height = '';
    this.host.style.overflowY = '';
    this.host.replaceChildren(next);
    this.plan(next, before, hostBefore, t0);
    this.tick(t0);
    if (this.tweens.length > 0 && this.frame === 0) {
      this.frame = requestAnimationFrame((now) => this.loop(now));
    }
  }

  /** Stop moving; `finish` puts everything where the frame drew it. */
  stop(finish: boolean): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (finish) for (const tw of this.tweens) tw.done();
    this.tweens = [];
  }

  dispose(): void {
    this.stop(true);
  }

  private parse(markup: string): SVGSVGElement | null {
    const tpl = document.createElement('template');
    tpl.innerHTML = this.opts.sanitize(markup);
    const svg = tpl.content.querySelector('svg');
    return svg instanceof SVGSVGElement ? svg : null;
  }

  /** Every part of the frame on screen, where it is right now. */
  private capture(svg: SVGSVGElement): Map<string, Before> {
    const out = new Map<string, Before>();
    for (const [key, el] of partsOf(svg)) {
      const ctm = screenOf(el);
      const parent = el.parentNode instanceof SVGGraphicsElement ? screenOf(el.parentNode) : null;
      const tag = el.tagName.toLowerCase();
      const entry: {
        -readonly [K in keyof Before]: Before[K];
      } = {
        key,
        el,
        tag,
        box: el.getBoundingClientRect(),
        parent,
        paints: paintsOf(el),
        shown: this.entering.get(el)?.() ?? 1,
      };
      if (ctm !== null && tag === 'rect') {
        const [x0, y0] = at(ctm, num(el, 'x'), num(el, 'y'));
        const [x1, y1] = at(ctm, num(el, 'x') + num(el, 'width'), num(el, 'y') + num(el, 'height'));
        entry.rect = [x0, y0, x1, y1];
      } else if (ctm !== null && tag === 'line') {
        entry.line = [at(ctm, num(el, 'x1'), num(el, 'y1')), at(ctm, num(el, 'x2'), num(el, 'y2'))];
      } else if (ctm !== null && tag === 'path' && roleOfKey(key) === 'edge') {
        const pts = flattenPath(el.getAttribute('d') ?? '');
        if (pts !== null) entry.points = resample(pts, BEND_POINTS).map(([x, y]) => at(ctm, x, y));
      }
      out.set(key, entry);
    }
    return out;
  }

  /** The moves from what was on screen to the frame now in the document. */
  private plan(
    svg: SVGSVGElement,
    before: Map<string, Before>,
    hostBefore: number,
    t0: number,
  ): void {
    const parts = partsOf(svg);
    const { added, removed } = diffKeys([...before.keys()], [...parts.keys()]);
    const fresh = new Set(added);
    const counts = { step: 0, edge: 0, label: 0 };
    for (const [key, el] of parts) {
      const was = before.get(key);
      if (fresh.has(key) || was === undefined || was.tag !== el.tagName.toLowerCase()) {
        this.enter(el, key, t0, counts, 0);
        continue;
      }
      this.glide(el, was, t0);
      // A part still coming in when this frame landed keeps coming in from there.
      if (was.shown < 0.999) this.enter(el, key, t0, counts, was.shown);
    }
    for (const key of removed) {
      const was = before.get(key);
      if (was !== undefined) this.leave(svg, was, t0);
    }
    // The card grows (or shrinks) to its new height instead of snapping.
    const hostAfter = this.host.getBoundingClientRect().height;
    if (Math.abs(hostAfter - hostBefore) > 0.5) {
      const host = this.host;
      this.tweens.push({
        el: host,
        start: t0 + TIMING.grow.delay,
        dur: TIMING.grow.dur,
        apply: (e) => {
          host.style.height = `${mix(hostBefore, hostAfter, e)}px`;
          // Clipped in height only: a label near a side may overhang, as in the
          // finished card. A clip, not a clip-path — a clip-path hid the rest of
          // the drawing but left it in the card's overflow, and the card showed
          // its "Open in canvas" fade (meant for a drawing too tall) while this
          // one was still growing (filmed 2026-09-25).
          host.style.overflowY = 'clip';
        },
        done: () => {
          host.style.height = '';
          host.style.overflowY = '';
        },
      });
    }
  }

  /** A part in both frames: from its old place, size, shape and colour to its new ones. */
  private glide(el: SvgEl, was: Before, t0: number): void {
    const { dur, delay } = TIMING.glide;
    const start = t0 + delay;
    const ctm = screenOf(el);
    const tag = el.tagName.toLowerCase();
    if (ctm !== null && tag === 'rect' && was.rect !== undefined) {
      const inv = ctm.inverse();
      const [x0, y0] = at(inv, was.rect[0], was.rect[1]);
      const [x1, y1] = at(inv, was.rect[2], was.rect[3]);
      const from = [x0, y0, x1 - x0, y1 - y0];
      const to = [num(el, 'x'), num(el, 'y'), num(el, 'width'), num(el, 'height')];
      if (from.some((v, i) => Math.abs(v - (to[i] ?? v)) > 0.3)) {
        this.tweens.push(attrTween(el, ['x', 'y', 'width', 'height'], from, to, start, dur));
      }
    } else if (ctm !== null && tag === 'line' && was.line !== undefined) {
      const inv = ctm.inverse();
      const [a, b] = was.line;
      const from = [...at(inv, a[0], a[1]), ...at(inv, b[0], b[1])];
      const names = ['x1', 'y1', 'x2', 'y2'];
      const to = names.map((n) => num(el, n));
      if (from.some((v, i) => Math.abs(v - (to[i] ?? v)) > 0.3)) {
        this.tweens.push(attrTween(el, names, from, to, start, dur));
      }
    } else if (ctm !== null && tag === 'path' && was.points !== undefined) {
      const d = el.getAttribute('d') ?? '';
      const pts = flattenPath(d);
      if (pts !== null) {
        const inv = ctm.inverse();
        const from = was.points.map(([x, y]) => at(inv, x, y));
        const to = resample(pts, BEND_POINTS);
        if (
          from.some((p, i) => Math.hypot(p[0] - (to[i]?.[0] ?? 0), p[1] - (to[i]?.[1] ?? 0)) > 0.3)
        ) {
          this.tweens.push({
            el,
            start,
            dur,
            apply: (e) => el.setAttribute('d', e >= 1 ? d : polyline(mixPoints(from, to, e))),
            done: () => el.setAttribute('d', d),
          });
        }
      }
    } else {
      this.flip(el, was, start, dur);
    }
    this.recolour(el, was, start, dur);
  }

  /** FLIP: from its old box on screen, by a transform put in front of its own. */
  private flip(el: SvgEl, was: Before, start: number, dur: number): void {
    const parent = el.parentNode instanceof SVGGraphicsElement ? screenOf(el.parentNode) : null;
    if (parent === null) return;
    const now = el.getBoundingClientRect();
    const inv = parent.inverse();
    const sdx = was.box.x + was.box.width / 2 - (now.x + now.width / 2);
    const sdy = was.box.y + was.box.height / 2 - (now.y + now.height / 2);
    const dx = inv.a * sdx + inv.c * sdy;
    const dy = inv.b * sdx + inv.d * sdy;
    const ratio =
      now.width > 0.5
        ? was.box.width / now.width
        : now.height > 0.5
          ? was.box.height / now.height
          : 1;
    const s = Math.min(2, Math.max(0.5, Number.isFinite(ratio) && ratio > 0 ? ratio : 1));
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3 && Math.abs(s - 1) < 0.01) return;
    const [cx, cy] = at(inv, now.x + now.width / 2, now.y + now.height / 2);
    const own = el.getAttribute('transform');
    this.tweens.push({
      el,
      start,
      dur,
      apply: (e) => {
        const k = 1 - e;
        const sc = mix(s, 1, e);
        el.setAttribute(
          'transform',
          `translate(${dx * k} ${dy * k}) translate(${cx} ${cy}) scale(${sc}) translate(${-cx} ${-cy})${own !== null ? ` ${own}` : ''}`,
        );
      },
      done: () =>
        own !== null ? el.setAttribute('transform', own) : el.removeAttribute('transform'),
    });
  }

  /** A fill or stroke that changed between the frames, mixed across. */
  private recolour(el: SvgEl, was: Before, start: number, dur: number): void {
    const now = paintsOf(el);
    if (now.length !== was.paints.length) return;
    const nodes = [el, ...el.querySelectorAll('*')];
    now.forEach((sig, i) => {
      const old = was.paints[i];
      if (old === undefined || old === sig) return;
      const [tagA, fillA, strokeA] = old.split('|');
      const [tagB, fillB, strokeB] = sig.split('|');
      const node = nodes[i];
      if (tagA !== tagB || node === undefined) return;
      for (const [attr, a, b] of [
        ['fill', fillA, fillB],
        ['stroke', strokeA, strokeB],
      ] as const) {
        if (
          a === b ||
          a === undefined ||
          b === undefined ||
          parseColor(a) === null ||
          parseColor(b) === null
        )
          continue;
        this.tweens.push({
          el: node,
          start,
          dur,
          apply: (e) => node.setAttribute(attr, mixColor(a, b, e)),
          done: () => node.setAttribute(attr, b),
        });
      }
    });
  }

  /** A new part: a step pops in, an edge draws itself, a word fades in. */
  private enter(
    el: SvgEl,
    key: string,
    t0: number,
    counts: { step: number; edge: number; label: number },
    from: number,
  ): void {
    const role = roleOfKey(key);
    const tag = el.tagName.toLowerCase();
    const timing =
      role === 'edge' || role === 'line'
        ? TIMING.edge
        : role === 'label'
          ? TIMING.label
          : TIMING.step;
    const slot = role === 'edge' || role === 'line' ? 'edge' : role === 'label' ? 'label' : 'step';
    // The title leads: it comes in at once, and takes no step's place in line.
    const start =
      t0 +
      (from > 0 || role === 'head'
        ? 0
        : timing.delay + Math.min(timing.most, counts[slot] * timing.stagger));
    if (role !== 'head') counts[slot] += 1;
    const dur = timing.dur * (1 - from);
    const dashed = (el.getAttribute('stroke-dasharray') ?? 'none') !== 'none';
    const drawable =
      (role === 'edge' || role === 'line') && !dashed && (tag === 'path' || tag === 'line');
    if (drawable) {
      const len =
        tag === 'line'
          ? Math.hypot(num(el, 'x2') - num(el, 'x1'), num(el, 'y2') - num(el, 'y1'))
          : lengthOf(flattenPath(el.getAttribute('d') ?? '') ?? []);
      if (len > 0.5) {
        // The head lands with the line: no arrowhead waiting at the far end
        // while the line is still on its way.
        const heads = ['marker-end', 'marker-start'].map((a) => [a, el.getAttribute(a)] as const);
        for (const [a, v] of heads) if (v !== null) el.removeAttribute(a);
        let progress = from;
        this.entering.set(el, () => progress);
        this.tweens.push({
          el,
          start,
          dur,
          apply: (e) => {
            progress = mix(from, 1, e);
            el.style.strokeDasharray = `${len} ${len}`;
            el.style.strokeDashoffset = String(len * (1 - progress));
          },
          done: () => {
            el.style.strokeDasharray = '';
            el.style.strokeDashoffset = '';
            for (const [a, v] of heads) if (v !== null) el.setAttribute(a, v);
            this.entering.delete(el);
          },
        });
        return;
      }
    }
    // Steps and groups pop a little (scale from 92 %); words and dashed lines just fade.
    const pops = role === 'step' || (role === 'group' && tag !== 'text');
    const box = el.getBoundingClientRect();
    const parent = el.parentNode instanceof SVGGraphicsElement ? screenOf(el.parentNode) : null;
    const centre =
      pops && parent !== null
        ? at(parent.inverse(), box.x + box.width / 2, box.y + box.height / 2)
        : null;
    const own = el.getAttribute('transform');
    let progress = from;
    this.entering.set(el, () => progress);
    this.tweens.push({
      el,
      start,
      dur,
      apply: (e) => {
        progress = mix(from, 1, e);
        el.style.opacity = String(progress);
        if (centre !== null) {
          const sc = mix(0.92, 1, progress);
          el.setAttribute(
            'transform',
            `translate(${centre[0]} ${centre[1]}) scale(${sc}) translate(${-centre[0]} ${-centre[1]})${own !== null ? ` ${own}` : ''}`,
          );
        }
      },
      done: () => {
        el.style.opacity = '';
        if (centre !== null) {
          if (own !== null) el.setAttribute('transform', own);
          else el.removeAttribute('transform');
        }
        this.entering.delete(el);
      },
    });
  }

  /** A part that is gone fades out where it was. */
  private leave(svg: SVGSVGElement, was: Before, t0: number): void {
    if (was.parent === null || was.shown < 0.05) return;
    let layer = svg.querySelector<SVGGElement>(':scope > g[data-pd-ghosts]');
    if (layer === null) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('data-pd-ghosts', '');
      layer.setAttribute('aria-hidden', 'true');
      svg.appendChild(layer);
    }
    const here = screenOf(layer);
    if (here === null) return;
    const ghost = was.el.cloneNode(true) as SvgEl;
    for (const x of [ghost, ...ghost.querySelectorAll('*')]) {
      x.removeAttribute('id');
      x.removeAttribute('data-k');
    }
    const m = here.inverse().multiply(was.parent);
    const own = ghost.getAttribute('transform');
    ghost.setAttribute(
      'transform',
      `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})${own !== null ? ` ${own}` : ''}`,
    );
    layer.appendChild(ghost);
    const from = was.shown;
    this.tweens.push({
      el: ghost,
      start: t0 + TIMING.leave.delay,
      dur: TIMING.leave.dur,
      apply: (e) => {
        ghost.style.opacity = String(from * (1 - e));
      },
      done: () => ghost.remove(),
    });
  }

  private tick(now: number): void {
    const left: Tween[] = [];
    for (const tw of this.tweens) {
      const t = (now - tw.start) / Math.max(1, tw.dur);
      if (t >= 1) {
        tw.apply(1);
        tw.done();
        continue;
      }
      tw.apply(easeOut(Math.max(0, t)));
      left.push(tw);
    }
    this.tweens = left;
  }

  private loop(now: number): void {
    this.frame = 0;
    this.tick(now);
    if (this.tweens.length > 0) this.frame = requestAnimationFrame((t) => this.loop(t));
  }
}
