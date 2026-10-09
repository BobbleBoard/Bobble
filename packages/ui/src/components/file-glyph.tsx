/**
 * THE FILE GLYPH — a page with its extension written on it, in strokes.
 *
 * The user (2026-09-20): "all files with specific types [use this icon] … replace
 * XML text based on file type procedurally, e.g. WAV". So the letters are not
 * text: each is a stroked letterform on the same 24-grid as the page, five
 * units tall on the baseline at 19, set from a small alphabet and laid out
 * to the right edge the way the Hugeicons file icons are — the page's own
 * right edge steps back when the label is wide (WAV's page is a unit
 * narrower than XML's).
 *
 * The letterforms come from those icons where they exist (A C D F G H I J L
 * M N O P R S T V W X Z 3 4 7 — Hugeicons, MIT) and are drawn here in the
 * same idiom where they do not (B E K Q U Y and the other digits): round
 * corners of radius ~1, stems of 5, bowls that meet the stem at mid-height.
 */
import { clsx } from 'clsx';
import type { CSSProperties, SVGProps } from 'react';

/** A letter: its path with the left edge at x=0, and its advance width. */
interface Letter {
  readonly w: number;
  readonly d: string;
}

/**
 * Shift (and optionally squeeze) the x of every coordinate in an absolute
 * path (M L H V C Z only — everything in this file). y is untouched.
 */
export function shiftPath(d: string, dx: number, sx = 1): string {
  const out: string[] = [];
  const re = /([MLHVCZ])([^MLHVCZ]*)/g;
  for (const m of d.matchAll(re)) {
    const cmd = m[1] as string;
    const nums = (m[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((t) => t.length > 0)
      .map(Number);
    if (cmd === 'Z') {
      out.push('Z');
      continue;
    }
    const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
    if (cmd === 'H') {
      out.push(`H${nums.map((x) => fmt(x * sx + dx)).join(' ')}`);
    } else if (cmd === 'V') {
      out.push(`V${nums.map(fmt).join(' ')}`);
    } else {
      // M, L, C: x y pairs
      const parts: string[] = [];
      for (let i = 0; i < nums.length; i += 2) {
        parts.push(`${fmt((nums[i] as number) * sx + dx)} ${fmt(nums[i + 1] as number)}`);
      }
      out.push(`${cmd}${parts.join(' ')}`);
    }
  }
  return out.join('');
}

const L = (w: number, d: string): Letter => ({ w, d });

/** The alphabet, each letter's left edge at 0, baseline 19, cap height 14. */
export const LETTERS: Readonly<Record<string, Letter>> = {
  A: L(4, 'M0 19L1.75 14H2.25L4 19M1 17.5H3'),
  B: L(
    3,
    'M0 14V19M0 14H1.75C2.4404 14 3 14.5596 3 15.25C3 15.9404 2.4404 16.5 1.75 16.5H0M0 16.5H1.75C2.4404 16.5 3 17.0596 3 17.75C3 18.4404 2.4404 19 1.75 19H0',
  ),
  C: L(
    3.3,
    'M3.2941 15.0163C3.2485 14.0244 2.57068 14 1.65122 14C0.23483 14 0 14.3384 0 15.6667V17.3333C0 18.6616 0.23483 19 1.65122 19C2.57068 19 3.2485 18.9756 3.2941 17.9837',
  ),
  D: L(3, 'M0 14H1.2857C2.2325 14 3 14.7462 3 15.6667V17.3333C3 18.2538 2.2325 19 1.2857 19H0V14Z'),
  E: L(2.5, 'M2.5 14H1C0.4477 14 0 14.4477 0 15V18C0 18.5523 0.4477 19 1 19H2.5M0 16.5H2'),
  F: L(3, 'M3 14H1C0.4477 14 0 14.4477 0 15V16.5M0 16.5V19M0 16.5H2.5'),
  G: L(
    3,
    'M3 15C3 14.4477 2.5523 14 2 14H1C0.4477 14 0 14.4477 0 15V18C0 18.5523 0.4477 19 1 19H2C2.5523 19 3 18.5523 3 18V17H2',
  ),
  H: L(3, 'M0 14V16.5M0 19V16.5M0 16.5H3M3 16.5V19M3 16.5V14'),
  I: L(0, 'M0 14V19'),
  J: L(3.5, 'M3.5 14V17.25C3.5 18.2165 2.7165 19 1.75 19H1.66667C0.74619 19 0 18.2538 0 17.3333'),
  K: L(3, 'M0 14V19M0 16.5L2.75 14M0 16.5L2.75 19'),
  L: L(2, 'M0 14V17C0 17.9428 0 18.4142 0.2929 18.7071C0.5858 19 1.0572 19 2 19'),
  M: L(4, 'M0 19V14L2 16.5L4 14V19'),
  N: L(3.5, 'M0 19V14L3.5 19V14'),
  O: L(
    3.3,
    'M1.6471 19C0.8707 19 0.4825 19 0.2412 18.7559C0 18.5118 0 18.119 0 17.3333V15.6667C0 14.881 0 14.4882 0.2412 14.2441C0.4825 14 0.8707 14 1.6471 14C2.4235 14 2.8117 14 3.053 14.2441C3.2942 14.4882 3.2942 14.881 3.2942 15.6667V17.3333C3.2942 18.119 3.2942 18.5118 3.053 18.7559C2.8117 19 2.4235 19 1.6471 19Z',
  ),
  P: L(3, 'M0 19V17M0 17V14H1.5C2.32843 14 3 14.6716 3 15.5C3 16.3284 2.32843 17 1.5 17H0Z'),
  Q: L(
    3.3,
    'M1.6471 19C0.8707 19 0.4825 19 0.2412 18.7559C0 18.5118 0 18.119 0 17.3333V15.6667C0 14.881 0 14.4882 0.2412 14.2441C0.4825 14 0.8707 14 1.6471 14C2.4235 14 2.8117 14 3.053 14.2441C3.2942 14.4882 3.2942 14.881 3.2942 15.6667V17.3333C3.2942 18.119 3.2942 18.5118 3.053 18.7559C2.8117 19 2.4235 19 1.6471 19ZM2.3 17.6L3.4 19.2',
  ),
  R: L(
    3,
    'M0 17V14H1.5C2.3284 14 3 14.6716 3 15.5C3 16.3284 2.3284 17 1.5 17M0 17V19M0 17H1.5M1.5 17L3 19',
  ),
  S: L(
    2.5,
    'M2.5 14H1C0.44771 14 0 14.4477 0 15V15.5C0 16.0523 0.44771 16.5 1 16.5H1.5C2.05228 16.5 2.5 16.9477 2.5 17.5V18C2.5 18.5523 2.05228 19 1.5 19H0',
  ),
  T: L(3, 'M0 14H1.5M1.5 14H3M1.5 14V19'),
  U: L(3, 'M0 14V17.5C0 18.3284 0.6716 19 1.5 19C2.3284 19 3 18.3284 3 17.5V14'),
  V: L(3.5, 'M0 14L1.75 19L3.5 14'),
  W: L(4, 'M0 14V19L2 16.5L4 19V14'),
  X: L(3, 'M0 14L1.5 16.5M1.5 16.5L3 19M1.5 16.5L3 14M1.5 16.5L0 19'),
  Y: L(3, 'M0 14L1.5 16.75M3 14L1.5 16.75M1.5 16.75V19'),
  Z: L(3, 'M3 19H0L3 14H0'),
  '0': L(
    3,
    'M1.5 19C0.7236 19 0.3354 19 0.0941 18.7559C0 18.5118 0 18.119 0 17.3333V15.6667C0 14.881 0 14.4882 0.0941 14.2441C0.3354 14 0.7236 14 1.5 14C2.2764 14 2.6646 14 2.9059 14.2441C3 14.4882 3 14.881 3 15.6667V17.3333C3 18.119 3 18.5118 2.9059 18.7559C2.6646 19 2.2764 19 1.5 19Z',
  ),
  '1': L(1.5, 'M0 15L1.5 14V19'),
  '2': L(
    3,
    'M0 15C0 14.4477 0.4477 14 1 14H2C2.5523 14 3 14.4477 3 15V15.5C3 15.95 2.8 16.35 2.45 16.65L0 19H3',
  ),
  '3': L(
    3,
    'M1.5477 16.5H2M2 16.5C2.5523 16.5 3 16.0523 3 15.5V15C3 14.4477 2.5523 14 2 14H1C0.4477 14 0 14.4477 0 15M2 16.5C2.5523 16.5 3 16.9477 3 17.5V17.75C3 18.4404 2.4404 19 1.75 19H1C0.4477 19 0 18.5523 0 18',
  ),
  '4': L(3, 'M0 14V15.5C0 16.0523 0.4477 16.5 1 16.5H3M3 16.5V14M3 16.5V19'),
  '5': L(3, 'M3 14H0V16.5H2C2.5523 16.5 3 16.9477 3 17.5V18C3 18.5523 2.5523 19 2 19H0'),
  '6': L(
    3,
    'M2.75 14H1.25C0.5596 14 0 14.5596 0 15.25V18C0 18.5523 0.4477 19 1 19H2C2.5523 19 3 18.5523 3 18V17.5C3 16.9477 2.5523 16.5 2 16.5H0',
  ),
  '7': L(3, 'M0 14H3L1 19'),
  '8': L(
    3,
    'M1.5 16.5C0.6716 16.5 0 15.9404 0 15.25C0 14.5596 0.6716 14 1.5 14C2.3284 14 3 14.5596 3 15.25C3 15.9404 2.3284 16.5 1.5 16.5ZM1.5 16.5C0.6716 16.5 0 17.0596 0 17.75C0 18.4404 0.6716 19 1.5 19C2.3284 19 3 18.4404 3 17.75C3 17.0596 2.3284 16.5 1.5 16.5Z',
  ),
  '9': L(
    3,
    'M0.25 19H1.75C2.4404 19 3 18.4404 3 17.75V15C3 14.4477 2.5523 14 2 14H1C0.4477 14 0 14.4477 0 15V15.5C0 16.0523 0.4477 16.5 1 16.5H3',
  ),
};

/**
 * The page (Hugeicons file outline) with its right edge at x=19 and its fold
 * at the top right; shifted left by a unit when the label is wide.
 */
const PAGE =
  'M19 11C19 10.1825 19 9.4306 18.8478 9.06306C18.6955 8.69552 18.4065 8.40649 17.8284 7.82843L13.0919 3.09188C12.593 2.593 12.3436 2.34355 12.0345 2.19575C11.9702 2.165 11.9044 2.13772 11.8372 2.11401C11.5141 2 11.1614 2 10.4558 2C7.21082 2 5.58831 2 4.48933 2.88607C4.26731 3.06508 4.06508 3.26731 3.88607 3.48933C3 4.58831 3 6.21082 3 9.45584V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H19M12 2.5V3C12 5.82843 12 7.24264 12.8787 8.12132C13.7574 9 15.1716 9 18 9H18.5';

/** The label a file's extension becomes: up to four glyphs the alphabet has. */
export function fileLabel(ext: string | undefined): string {
  return (ext ?? '')
    .replace(/^\./, '')
    .toUpperCase()
    .split('')
    .filter((c) => c in LETTERS)
    .slice(0, 4)
    .join('');
}

/**
 * Lay a label out: letters right-aligned near the page's lower-right corner,
 * a wider label starting further left, squeezed only when four wide letters
 * would not fit. Returns the letter paths in place and the page's shift.
 */
export function layoutLabel(label: string): { readonly letters: string[]; readonly page: string } {
  const glyphs = label.split('').map((c) => LETTERS[c] as Letter);
  if (glyphs.length === 0) return { letters: [], page: PAGE };
  let gap = glyphs.length >= 4 ? 1.75 : 2.25;
  let width = glyphs.reduce((n, g) => n + g.w, 0) + gap * (glyphs.length - 1);
  const MAX = 17.5;
  if (width > MAX) {
    gap = 1.25;
    width = glyphs.reduce((n, g) => n + g.w, 0) + gap * (glyphs.length - 1);
  }
  const sx = width > MAX ? MAX / width : 1;
  const laid = width * sx;
  const right = laid >= 14.5 ? 22 : 21;
  const start = right - laid;
  const letters: string[] = [];
  let x = start;
  for (const g of glyphs) {
    letters.push(shiftPath(g.d, x, sx));
    x += (g.w + gap) * sx;
  }
  const edge = start <= 6 ? 18 : 19;
  return { letters, page: shiftPath(PAGE, edge - 19) };
}

export interface FileGlyphProps extends SVGProps<SVGSVGElement> {
  /** The extension, with or without its dot. */
  readonly ext?: string;
  readonly size?: number;
}

/** A page with the extension on it; a plain page when there is none. */
export function FileGlyph({ ext, size = 16, className, style, ...rest }: FileGlyphProps) {
  const label = fileLabel(ext);
  const { letters, page } = layoutLabel(label);
  return (
    <svg
      width={size}
      height={size}
      style={{ ...style, '--pd-icon-base': size } as CSSProperties}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx('pd-icon pd-glyph pd-file-glyph', className)}
      data-ext={label.toLowerCase()}
      aria-hidden="true"
      {...rest}
    >
      <path d={page} vectorEffect="non-scaling-stroke" />
      {letters.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed layout, never reordered
        <path key={i} d={d} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
