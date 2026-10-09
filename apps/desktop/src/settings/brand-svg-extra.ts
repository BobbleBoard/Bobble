/**
 * MARKS SIMPLE-ICONS DOES NOT SHIP. Hand-curated, not generated — that is why
 * this file is separate from brand-svg.ts, which `scripts/gen-brand-icons.mjs`
 * overwrites.
 *
 * The user: "can you seriously not find any chatgpt / openai logo? that's the codex
 * logo, and find something to use for hermes". The user is right that the earlier
 * answer — a monogram for both — was a cop-out. Two different situations:
 *
 * OPENAI. Genuinely absent from simple-icons, but the mark itself is published
 * and its geometry is exact: one path repeated at 60° around the centre. Taken
 * from the published SVG rather than redrawn, because an approximated logo is
 * the kind of wrong that looks fine to whoever drew it and wrong to everyone
 * who knows the brand.
 *
 * HERMES. Nous Research's own mark is their character illustration (the
 * `safari-pinned-tab.svg` on nousresearch.com). MEASURED at the size we use it:
 * at 18px and 32px it renders as an unreadable dark smudge — it is a portrait,
 * not a logo, and portraits do not survive a glyph. So per the user's fallback
 * instruction ("if they don't have official mark then figure something else out
 * that's clean and communicates that it's hermes") this is a caduceus: winged
 * staff, orb, one crossbar. Drawn as FILLED shapes rather than strokes because
 * thin strokes disintegrate below ~20px, and checked at 16/18/20/32px on the
 * real tile colour before being committed. It is ours, not theirs — no
 * suggestion of a Nous logo, and nothing to get wrong.
 *
 * Marks belong to their owners; presence here identifies a product in a list and
 * implies no endorsement.
 */

export interface ExtraBrandSvg {
  readonly title: string;
  readonly hex: string;
  readonly viewBox: string;
  /** Each entry becomes one `<path>`, optionally inside a transform group. */
  readonly paths: readonly { readonly d: string; readonly transform?: string }[];
}

/** The OpenAI knot: one sixth of the figure, rotated five times. */
const OPENAI_SIXTH =
  'M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z';

export const EXTRA_BRAND_SVGS: Readonly<Record<string, ExtraBrandSvg>> = {
  codex: {
    title: 'OpenAI',
    hex: '#10A37F',
    viewBox: '0 0 2406 2406',
    // 0/60/120/180/240/300 — the mark's own six-fold symmetry.
    paths: [0, 60, 120, 180, 240, 300].map((deg) => ({
      d: OPENAI_SIXTH,
      ...(deg === 0 ? {} : { transform: `rotate(${deg} 1203 1203)` }),
    })),
  },
  hermes: {
    title: 'Hermes',
    hex: '#6366F1',
    viewBox: '0 0 24 24',
    paths: [
      // orb
      { d: 'M12 1.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z' },
      // staff
      { d: 'M10.8 6.2h2.4v14.6a1.2 1.2 0 0 1-2.4 0z' },
      // wings
      { d: 'M10.3 7.4C7.9 5.2 4.6 4.3.6 4.8c.8 3.5 4 5.9 9.7 6.8z' },
      { d: 'M13.7 7.4c2.4-2.2 5.7-3.1 9.7-2.6-.8 3.5-4 5.9-9.7 6.8z' },
      // the entwined crossbar
      { d: 'M7.6 13.2c2.9 1.7 5.9 1.7 8.8 0l1.1 1.9c-3.6 2.1-7.4 2.1-11 0z' },
    ],
  },
};
