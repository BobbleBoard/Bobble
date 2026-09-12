/**
 * Is this CSS colour dark? — for deciding which way to theme an editor view.
 *
 * SEEN: `--pd-bg-base` in the light theme computes to `#f5f5f7`, and the
 * previous check pulled "the digits" out of it — 5, 5, 7 — and called that
 * rgb(5,5,7): dark. So every office editor was themed DARK inside a light app:
 * a charcoal "Show toolbar" pill on a white pane, in the user's own screenshot.
 * The dark theme (`#151517` → 15,15,17) happened to agree with the truth, which
 * is how it survived. Parse the colour; never scrape its digits.
 */
export function parseCssColor(value: string): { r: number; g: number; b: number } | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v)?.[1];
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b] = [0, 1, 2].map((i) => Number.parseInt(`${hex[i]}${hex[i]}`, 16));
      return { r: r as number, g: g as number, b: b as number };
    }
    if (hex.length === 6 || hex.length === 8) {
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      return { r: r as number, g: g as number, b: b as number };
    }
    return null;
  }
  const fn = /^(rgba?|color)\((.*)\)$/i.exec(v);
  if (fn !== null) {
    const parts = (fn[2] as string)
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter((p) => p.length > 0 && !/^srgb|display-p3|rec2020$/i.test(p));
    const nums = parts.map((p) =>
      p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p),
    );
    if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return null;
    // `color(srgb 0.96 0.96 0.97)` carries channels in 0..1; rgb() in 0..255.
    const scale = fn[1]?.toLowerCase() === 'color' ? 255 : 1;
    return {
      r: (nums[0] as number) * scale,
      g: (nums[1] as number) * scale,
      b: (nums[2] as number) * scale,
    };
  }
  return null;
}

/** Perceived luminance, 0..255 — the classic 299/587/114 weighting. */
export function lumaOf(value: string): number | null {
  const c = parseCssColor(value);
  return c === null ? null : (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
}

/** Dark below mid-grey. Unparseable colours are NOT dark — the light theme is the default. */
export function isDarkColor(value: string): boolean {
  const l = lumaOf(value);
  return l !== null && l < 128;
}
