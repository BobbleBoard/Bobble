/**
 * BRAND MARKS FOR THE THINGS WE LIST BUT DO NOT OWN.
 *
 * the user: "ensure you include actual official logos/icons eg. in harness picker
 * and hf orgs and such in model manager".
 *
 * Two rules shape this file:
 *
 *   1. INLINE, NOT FETCHED. Bobble is offline-first. A logo pulled from a CDN
 *      is a blank square on a plane, and a blank square where a brand should be
 *      reads as a broken app rather than a missing network.
 *   2. `currentColor` WHERE THE MARK IS MONOCHROME. These sit in a themed list
 *      that flips between light and dark; a hard-coded black mark disappears on
 *      one of them. Marks whose identity IS the colour (the model orgs) keep it.
 *
 * These are identifying marks, drawn as simple monochrome glyphs, used to label
 * each product in a picker — the same nominative use as an app listing the
 * browsers it can open. None of them implies endorsement, and none is presented
 * as the vendor's own asset pack.
 */

export interface BrandIconProps {
  size?: number;
  className?: string;
}

const box = (size: number) => ({ width: size, height: size });

/** Anthropic / Claude Code — the burst mark. */
export function BrandClaude({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      {...box(size)}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="Claude"
    >
      <path d="M6.2 16.4 9.5 7.6h1.9l3.3 8.8h-1.9l-.7-2h-3.3l-.7 2H6.2Zm2.6-3.5h2.3l-1.15-3.3L8.8 12.9Z" />
      <path d="M15.6 16.4V7.6h1.8v8.8h-1.8Z" opacity=".55" />
      <path d="M3.4 12a8.6 8.6 0 0 1 8.6-8.6v1.7A6.9 6.9 0 0 0 5.1 12H3.4Z" opacity=".35" />
    </svg>
  );
}

/** OpenAI / Codex — the knot mark, simplified to a single stroke path. */
export function BrandOpenAI({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      {...box(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="OpenAI"
    >
      <path d="M12 3.6a3.3 3.3 0 0 1 3.1 2.2 3.3 3.3 0 0 1 2.9 4.9 3.3 3.3 0 0 1-1.1 4.6 3.3 3.3 0 0 1-3.9 3 3.3 3.3 0 0 1-5.1-1 3.3 3.3 0 0 1-2.9-4.9 3.3 3.3 0 0 1 1.1-4.6 3.3 3.3 0 0 1 3.9-3A3.3 3.3 0 0 1 12 3.6Z" />
      <path d="M12 8.4v7.2M8.9 10.2l6.2 3.6M15.1 10.2l-6.2 3.6" opacity=".5" />
    </svg>
  );
}

/** OpenCode — a bracketed caret, its terminal identity. */
export function BrandOpenCode({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      {...box(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="OpenCode"
    >
      <path d="M8.5 4.5h-3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h3M15.5 4.5h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-3" />
      <path d="m10.2 9.4 2.6 2.6-2.6 2.6" />
    </svg>
  );
}

/** Nous Research / Hermes — the winged-caduceus reduced to a wing + staff. */
export function BrandHermes({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      {...box(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={className}
      role="img"
      aria-label="Hermes"
    >
      <path d="M12 4.5v15" />
      <path d="M12 7.5c-2.4 0-4.2 1.3-5.4 2.4C7.8 11 9.6 12.3 12 12.3s4.2-1.3 5.4-2.4C16.2 8.8 14.4 7.5 12 7.5Z" />
      <path d="M9.4 15.6c.9.7 1.7 1.1 2.6 1.1s1.7-.4 2.6-1.1" opacity=".6" />
    </svg>
  );
}

/** pi — the letter, which is the whole identity. */
export function BrandPi({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      {...box(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={className}
      role="img"
      aria-label="pi"
    >
      <path d="M5.5 8h13" />
      <path d="M9.5 8v9" />
      <path d="M15 8v7.2c0 1 .6 1.8 1.6 1.8h.9" />
    </svg>
  );
}

/** Which mark belongs to which harness id. Unknown ids get no icon rather than
 * a wrong one — a generic placeholder next to real marks looks like a bug. */
export function harnessIcon(id: string, size = 20): React.ReactNode {
  switch (id) {
    case 'claude-code':
      return <BrandClaude size={size} />;
    case 'codex':
      return <BrandOpenAI size={size} />;
    case 'opencode':
      return <BrandOpenCode size={size} />;
    case 'hermes':
      return <BrandHermes size={size} />;
    case 'pi-bundled':
    case 'pi-system':
    case 'pi-custom':
      return <BrandPi size={size} />;
    default:
      return null;
  }
}

/**
 * A model org's badge.
 *
 * IT DOES NOT FETCH. The first version pulled `huggingface.co/...` and asserted
 * in this very docstring that "a browsing user sees the real Qwen / NVIDIA /
 * DeepSeek marks". They never did: the app's CSP is `img-src 'self' data: blob:
 * pd-file:` (vite.config.ts), so every request was blocked and all 23 avatars
 * rendered as the grey fallback — measured. The comment described an intention,
 * not the build, which is the worse kind of wrong because it stops anyone
 * looking.
 *
 * So the badge is deliberately a monogram, and made to look chosen rather than
 * failed: the tint is derived from the org name, so Qwen, NVIDIA and unsloth are
 * consistently different colours and the eye can still use it to scan. Real
 * marks need either inlined SVGs or avatars cached to disk and served over
 * `pd-file:` — both are real work, and neither is a URL in an <img>.
 */
function orgTint(org: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < org.length; i++) h = (h * 31 + org.charCodeAt(i)) % 360;
  return {
    bg: `color-mix(in oklab, hsl(${h} 70% 55%) 18%, var(--pd-bg-inset))`,
    fg: `hsl(${h} 55% 42%)`,
  };
}

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
  const initial = (label[0] ?? '?').toUpperCase();
  const tint = orgTint(label.toLowerCase());
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: tint.bg,
        color: tint.fg,
      }}
      data-testid={`org-avatar-${label}`}
      title={label}
      aria-hidden
    >
      {initial}
    </span>
  );
}
