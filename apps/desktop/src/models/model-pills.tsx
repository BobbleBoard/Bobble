/**
 * CAPABILITY PILLS — the coloured chips that carry most of a model row's
 * legibility in the reference.
 *
 * The user, comparing ours to Unsloth Studio: "way worse currently needs to be
 * brought up". A large part of that gap was here. Ours rendered a lowercase
 * enum value (`vision`) in one grey, or an EMOJI in a grey square — full-colour
 * glyphs in an otherwise monochrome UI, at the mercy of the system emoji font.
 * The reference uses Title Case pills, each in its OWN colour, with a
 * monochrome icon.
 *
 * The colour is not decoration: it is what lets the eye scan a long list and
 * find the vision models without reading. That only works if each capability
 * keeps the same colour everywhere it appears — list, detail pane, filter menu —
 * so the mapping lives here rather than at three call sites.
 *
 * Colours come from the app's status tokens rather than raw hex so the pills
 * re-theme with everything else; `color-mix` against the surface keeps them
 * legible in both light and dark instead of a fixed pastel that goes muddy.
 */
import { IconBrain, IconChat, IconEye, IconImage, IconMic } from '@pi-desktop/ui';
import type { ReactNode } from 'react';

export type Capability = 'reasoning' | 'vision' | 'audio' | 'embeddings' | 'image-generation';

interface CapabilityStyle {
  readonly label: string;
  readonly icon: ReactNode;
  /** A `--pd-*` token base; bg/fg are mixed from it. */
  readonly token: string;
}

const STYLES: Record<Capability, CapabilityStyle> = {
  reasoning: {
    label: 'Reasoning',
    icon: <IconBrain size={12} />,
    token: '--pd-accent-primary',
  },
  vision: { label: 'Vision', icon: <IconEye size={12} />, token: '--pd-status-info-fg' },
  audio: { label: 'Audio', icon: <IconMic size={12} />, token: '--pd-status-warning-fg' },
  embeddings: {
    label: 'Embeddings',
    icon: <IconChat size={12} />,
    token: '--pd-status-success-fg',
  },
  'image-generation': {
    label: 'Image generation',
    icon: <IconImage size={12} />,
    token: '--pd-status-danger-fg',
  },
};

export function capabilityLabel(cap: string): string {
  return STYLES[cap as Capability]?.label ?? cap;
}

/**
 * One pill. `dense` drops the label and keeps the icon, for the table column
 * where five capabilities would otherwise blow the row width — the colour still
 * does the scanning work.
 */
export function CapabilityPill({ cap, dense = false }: { cap: string; dense?: boolean }) {
  const style = STYLES[cap as Capability];
  if (style === undefined) return null;
  const bg = `color-mix(in oklab, var(${style.token}) 14%, transparent)`;
  const border = `color-mix(in oklab, var(${style.token}) 34%, transparent)`;
  const fg = `var(${style.token})`;
  return (
    <span
      title={style.label}
      data-testid={`cap-${cap}`}
      className={
        dense
          ? 'inline-flex h-6 w-6 items-center justify-center rounded-full border'
          : // Fully rounded and BORDERED, matching Pill.tsx — the user asked for the
            // hub's tags to be "bordered pill colored highlight and such", and a
            // squarer, borderless chip beside a pill reads as two systems.
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-medium leading-tight'
      }
      style={{ background: bg, borderColor: border, color: fg }}
    >
      {style.icon}
      {dense ? null : style.label}
    </span>
  );
}

export function CapabilityPills({
  caps,
  dense = false,
  max,
}: {
  caps: readonly string[];
  dense?: boolean;
  max?: number;
}) {
  const shown = max === undefined ? caps : caps.slice(0, max);
  const extra = caps.length - shown.length;
  if (caps.length === 0) {
    // A WORD, not a dash. It used to be an em dash, on the argument that it
    // says "we know, and there are none" — but a dash is a shrug, and the row
    // is one line either way.
    return <span className="text-footnote text-text-muted">Text only</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((c) => (
        <CapabilityPill key={c} cap={c} dense={dense} />
      ))}
      {extra > 0 ? <span className="text-caption text-text-muted">+{extra}</span> : null}
    </span>
  );
}
