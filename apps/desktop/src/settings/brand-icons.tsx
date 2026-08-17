/**
 * BRAND MARKS FOR THE THINGS WE LIST BUT DO NOT OWN.
 *
 * the user: "ensure you include actual official logos/icons eg. in harness picker
 * and hf orgs and such in model manager", then "use official svgs".
 *
 * The marks are the vendors' OWN artwork, extracted from simple-icons (CC0-1.0)
 * into the generated brand-svg.ts. Three rules:
 *
 *   1. INLINE, NOT FETCHED. The app's CSP is `img-src 'self' data: blob:
 *      pd-file:`, and it is offline-first — a logo behind a URL is a blank
 *      square, which reads as a broken app rather than a missing network. An
 *      earlier version of this file fetched avatars and every one was blocked.
 *   2. A WRONG MARK IS WORSE THAN NONE. Two brands we list have no correct mark
 *      available: OpenAI/Codex (not in simple-icons — trademark enforcement) and
 *      Nous Research's Hermes (simple-icons' `siHermes` is the parcel company).
 *      Neither gets an invented approximation; both fall back to a monogram.
 *      The previous hand-drawn Claude mark read as the letters "AI", which is
 *      exactly the failure this rule exists to prevent.
 *   3. BRAND COLOUR ON A NEUTRAL TILE. Each mark renders in its own hex on a
 *      tinted tile, so the row is scannable in both themes without a black
 *      glyph vanishing into a dark background.
 *
 * Using a vendor's mark to identify their product in a picker is nominative
 * use; none of it implies endorsement.
 */
import { useEffect, useState } from 'react';
import { BRAND_SVGS } from './brand-svg';

export interface BrandIconProps {
  size?: number;
  className?: string;
}

/**
 * One official mark, in its own brand colour on a soft tile of that colour.
 * `title` is on the <svg> so the mark is announced rather than silent.
 */
export function BrandMark({
  id,
  size = 20,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const brand = BRAND_SVGS[id];
  if (brand === undefined) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={brand.hex}
      className={className}
      role="img"
      aria-label={brand.title}
    >
      <title>{brand.title}</title>
      <path d={brand.path} />
    </svg>
  );
}

/** The π glyph for pi itself — a letter, not a logo, so drawing it is honest. */
export function BrandPi({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={className}
      role="img"
      aria-label="pi"
    >
      <title>pi</title>
      <path d="M5.5 8h13" />
      <path d="M9.5 8v9" />
      <path d="M15 8v7.2c0 1 .6 1.8 1.6 1.8h.9" />
    </svg>
  );
}

/** Which mark belongs to which harness id. Unknown ids get no icon rather than
 * a wrong one — a generic placeholder next to real marks looks like a bug. */
/**
 * A harness's icon AS A TILE — mark plus its own background.
 *
 * the user: "not rendering properly in this case… especially the background for the
 * icon is important for example the free floating pi looks odd in ours still."
 * Two faults: `harnessIcon` returned null for the marks we do not have, so Codex
 * and Hermes rendered as EMPTY circles, which looks broken rather than
 * unbranded; and the ones we do have sat on a flat neutral tile so the glyph
 * floated.
 *
 * Every harness now gets a tile tinted from its own brand colour, and anything
 * without a mark falls back to a monogram rather than nothing. A letter reads as
 * "no logo available"; an empty circle reads as "your app failed to draw".
 */
const HARNESS_FALLBACK: Record<string, { letter: string; hex: string }> = {
  // Brand colours taken from each product's own materials, used only to tint a
  // monogram tile — not to imitate a mark we do not have.
  codex: { letter: 'C', hex: '#10A37F' },
  hermes: { letter: 'H', hex: '#6366F1' },
};

export function HarnessIcon({ id, size = 32 }: { id: string; size?: number }) {
  const isPi = id.startsWith('pi-');
  const brand = isPi ? undefined : BRAND_SVGS[id];
  const fallback = HARNESS_FALLBACK[id];
  const glyph = Math.round(size * 0.56);

  // pi is a letterform rather than a logo, so it gets a neutral tile and the
  // app's own ink — tinting it would invent a brand colour for it.
  if (isPi) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-bg-active text-text-primary"
        style={{ width: size, height: size }}
        data-testid={`harness-icon-${id}`}
      >
        <BrandPi size={glyph} />
      </span>
    );
  }

  if (brand !== undefined) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-lg"
        style={{
          width: size,
          height: size,
          background: `color-mix(in oklab, ${brand.hex} 16%, var(--pd-bg-inset))`,
        }}
        data-testid={`harness-icon-${id}`}
      >
        <BrandMark id={id} size={glyph} />
      </span>
    );
  }

  const tint = fallback?.hex ?? 'var(--pd-text-muted)';
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg font-medium"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `color-mix(in oklab, ${tint} 16%, var(--pd-bg-inset))`,
        color: tint,
      }}
      data-testid={`harness-icon-${id}`}
      aria-hidden
    >
      {fallback?.letter ?? id.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * ORG NAME → OFFICIAL MARK.
 *
 * Hugging Face orgs do not match brand ids one-for-one: `mlx-community` and
 * `unsloth` are re-publishers with no mark in the set, while a model's actual
 * author shows through the org for the big labs. Matching on a substring is
 * deliberate — `Qwen`, `qwen-ai` and `Qwen2` should all get Qwen's mark.
 */
const ORG_MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/qwen/i, 'qwen'],
  [/nvidia/i, 'nvidia'],
  [/deepseek/i, 'deepseek'],
  [/^meta|facebook/i, 'meta'],
  [/google|gemma/i, 'google'],
  [/mistral/i, 'mistralai'],
  [/minimax/i, 'minimax'],
  [/moonshot/i, 'moonshotai'],
  [/kimi/i, 'kimi'],
  [/ollama/i, 'ollama'],
  [/hugging ?face|^hf$/i, 'huggingface'],
];

function orgMarkId(org: string): string | undefined {
  for (const [re, id] of ORG_MARKS) if (re.test(org)) return id;
  return undefined;
}

/**
 * A model org's badge: its official mark where one exists, otherwise a tinted
 * monogram.
 *
 * The monogram is not a failure state — most HF orgs (`unsloth`,
 * `mlx-community`, an individual's handle) have no registered mark, and that is
 * the normal case rather than the exception. It is tinted from the name so the
 * eye can still use it to scan a list, which a uniform grey square could not.
 *
 * An earlier version fetched avatars from huggingface.co and asserted in its own
 * docstring that users saw the real marks. They never did — the CSP blocked
 * every request and all 23 rendered grey. Marks are inlined now for that reason.
 */
function orgTint(org: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < org.length; i++) h = (h * 31 + org.charCodeAt(i)) % 360;
  return {
    bg: `color-mix(in oklab, hsl(${h} 70% 55%) 18%, var(--pd-bg-inset))`,
    fg: `hsl(${h} 55% 42%)`,
  };
}

/**
 * One in-flight/settled lookup per org, shared across every row that shows it.
 * A list of 40 models with 8 distinct orgs must make 8 requests, not 40.
 */
const avatarCache = new Map<string, Promise<{ path?: string; verified?: boolean }>>();

function lookupAvatar(org: string): Promise<{ path?: string; verified?: boolean }> {
  const key = org.toLowerCase();
  const hit = avatarCache.get(key);
  if (hit !== undefined) return hit;
  const p = window.piDesktop
    .invoke('orgavatar:fetch', { org })
    .then((r) => ({ path: r.path, verified: r.verified }))
    .catch(() => ({}));
  avatarCache.set(key, p);
  return p;
}

/**
 * A model org's badge: its REAL avatar where Hugging Face has one, then an
 * official simple-icons mark, then a tinted monogram.
 *
 * The order matters. HF's own avatar is what the reference shows and covers
 * every publisher including individuals; the bundled marks cover the big labs
 * when offline or before the fetch lands; the monogram keeps the row's shape
 * when neither exists. The avatar arrives as a `pd-file://` URL — main caches
 * it to disk precisely because the CSP blocks a remote <img>, which is how the
 * first version of this managed to render 23 grey squares.
 */
export function OrgAvatar({
  org,
  size = 28,
  className,
}: {
  org: string;
  size?: number;
  className?: string;
}) {
  const label = org.trim();
  const markId = orgMarkId(label);
  const brand = markId === undefined ? undefined : BRAND_SVGS[markId];
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (label === '') return;
    let live = true;
    void lookupAvatar(label).then((r) => {
      if (live && r.path !== undefined) setSrc(r.path);
    });
    return () => {
      live = false;
    };
  }, [label]);

  const shell = (children: React.ReactNode, style?: React.CSSProperties) => (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-medium ${className ?? ''}`}
      style={{ width: size, height: size, ...style }}
      data-testid={`org-avatar-${label}`}
      title={label}
    >
      {children}
    </span>
  );

  if (src !== undefined) {
    return shell(
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        onError={() => setSrc(undefined)}
      />,
    );
  }

  if (brand !== undefined && markId !== undefined) {
    return shell(<BrandMark id={markId} size={Math.round(size * 0.62)} />, {
      background: `color-mix(in oklab, ${brand.hex} 14%, var(--pd-bg-inset))`,
    });
  }

  const initial = (label[0] ?? '?').toUpperCase();
  const tint = orgTint(label.toLowerCase());
  return shell(initial, {
    background: tint.bg,
    color: tint.fg,
    fontSize: Math.round(size * 0.42),
  });
}
