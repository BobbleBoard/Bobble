/** What the renderer draws, in pixels — the shapes the checks measure and the SVG is written from. */

/** A CSS class suffix: a role (main, second, third, reference, highlight) or ink, mute, axis, grid. */
export type Tone = string;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How much of a part shows: its own opacity (a spec's, or a fade in), and a dimming on its way in or out. */
export interface Fade {
  /** 0 … 1: the part's own opacity. */
  readonly alpha?: number;
  /** 0 … 1: how far dimmed, while a step's highlight changes (else `dim` says). */
  readonly dimMix?: number;
}

export type Drawable = Fade &
  (
    | {
        readonly t: 'line';
        readonly x1: number;
        readonly y1: number;
        readonly x2: number;
        readonly y2: number;
        readonly tone: Tone;
        readonly width: number;
        readonly dash?: boolean;
        readonly id?: string;
        readonly dim?: boolean;
        readonly clip?: boolean;
      }
    | {
        readonly t: 'path';
        readonly d: string;
        readonly tone: Tone;
        readonly width: number;
        readonly fill?: Tone;
        readonly fillOpacity?: number;
        readonly dash?: boolean;
        readonly id?: string;
        readonly dim?: boolean;
        readonly clip?: boolean;
      }
    | {
        readonly t: 'dot';
        readonly x: number;
        readonly y: number;
        readonly r: number;
        readonly tone: Tone;
        readonly id?: string;
        readonly dim?: boolean;
      }
    | {
        readonly t: 'text';
        readonly x: number;
        readonly y: number;
        readonly text: string;
        readonly anchor: 'start' | 'middle' | 'end';
        readonly size: number;
        readonly tone: Tone;
        /** The measured box, for the overlap checks. */
        readonly box: Box;
        /** A short line in this tone before the text: the key that ties a label to its curve. */
        readonly key?: Tone;
        readonly italic?: boolean;
        readonly id?: string;
        readonly dim?: boolean;
        /** Placed by the layout (a curve's or a point's label) rather than fixed (a tick). */
        readonly placed?: boolean;
        /** No clear spot was found: what the chosen one touches — boxes (labels, points, discs) and line points. */
        readonly crowd?: { readonly boxes: number; readonly points: number };
      }
  );

export interface Panel {
  readonly kind: 'plot' | 'figure';
  readonly w: number;
  readonly h: number;
  /** The drawing area (a plot's axes box; a figure's whole view). */
  readonly area: Box;
  readonly items: readonly Drawable[];
  /** Items the spec positions that fell outside what is shown: id → where. */
  readonly outside: readonly { readonly id: string; readonly what: string }[];
  /** Curves with nothing to draw, or mostly nothing: id → the share of samples that had a value. */
  readonly curveHealth: readonly {
    readonly id: string;
    readonly finite: number;
    readonly flat: boolean;
    readonly usesVar: boolean;
  }[];
}

export interface Scene {
  readonly panels: readonly Panel[];
}

/** The little of the DOM the page's script touches — typed here, so the package needs no DOM library. */
export interface PageEvent {
  readonly key?: string;
  readonly target?: { readonly tagName?: string } | null;
}
export interface PageEl {
  innerHTML: string;
  textContent: string | null;
  value: string;
  readonly classList: {
    toggle(c: string, on?: boolean): void;
    add(c: string): void;
    remove(c: string): void;
  };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (ev: PageEvent) => void): void;
}
export interface PageDoc {
  querySelector(sel: string): PageEl | null;
  querySelectorAll(sel: string): ArrayLike<PageEl>;
  addEventListener(type: string, fn: (ev: PageEvent) => void): void;
  readonly activeElement: unknown;
}
export interface PageWin {
  requestAnimationFrame(fn: (now: number) => void): number;
  cancelAnimationFrame(id: number): void;
  matchMedia?(q: string): { readonly matches: boolean } | undefined;
  readonly performance: { now(): number };
}
