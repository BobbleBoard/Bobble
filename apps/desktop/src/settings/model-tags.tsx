/**
 * Round-10 Wave C (#20b): the Model Manager's capability/attribute PILL TAGS.
 *
 * Every model surface (curated {@link ModelCard}, HF {@link HfResultCard}, the
 * Recommended banner, and the Apple card) renders its attributes as larger,
 * COLORED pills instead of the old tiny grey text — one distinct hue per
 * attribute so a card's capabilities read at a glance:
 *   vision → rose · recommended → green · audio → amber · MTP → blue ·
 *   EAGLE-3 → teal · DFlash → indigo · reliable → green · engine → slate ·
 *   gated → neutral/locked · size & quant → neutral.
 * (MTP + EAGLE-3 + DFlash are the speculative-decoding "fast" pills; all use the
 * bolt. round-12: DFlash is real upstream now, reliable-publisher + engine pills.)
 * The pill chrome + per-hue colours live app-locally in `styles/global.css`
 * (`.pd-mm-pill*`) — deliberately NOT in @pi-desktop/ui (Wave B owns that) — and
 * are tuned for AA contrast in both light and dark modes.
 */
import { Glyph } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { IconBolt, IconEye, IconLock, IconShield, IconSparkle, IconWaveform } from './icons';
import { type SpecMethod, VARIANT_LABEL } from './model-manager-logic';

/** The attribute a pill represents; drives its colour class + default glyph. */
export type ModelTagKind =
  | 'vision'
  | 'recommended'
  | 'audio'
  | 'modality'
  | 'mtp'
  | 'eagle3'
  | 'dflash'
  | 'dspark'
  | 'reliable'
  | 'engine'
  | 'gated'
  | 'size'
  | 'quant'
  | 'neutral';

/** Default glyph per kind (neutral/size/quant are glyph-less by design). */
function defaultIcon(kind: ModelTagKind): ReactNode {
  switch (kind) {
    case 'vision':
      return <IconEye size={12} />;
    case 'recommended':
      return <IconSparkle size={12} />;
    case 'audio':
      return <IconWaveform size={12} />;
    case 'mtp':
    case 'eagle3':
    case 'dflash':
      return <IconBolt size={12} />;
    case 'reliable':
      return <IconShield size={12} />;
    case 'engine':
      return <Glyph name="engine" size={12} />;
    case 'gated':
      return <IconLock size={11} />;
    default:
      return null;
  }
}

export interface ModelTagProps {
  kind: ModelTagKind;
  children: ReactNode;
  /** Override the default glyph; pass `null` to render a text-only pill. */
  icon?: ReactNode | null;
  title?: string;
  'data-testid'?: string;
}

/** One colored capability pill. */
export function ModelTag({ kind, children, icon, title, ...rest }: ModelTagProps) {
  const glyph = icon === undefined ? defaultIcon(kind) : icon;
  return (
    <span
      className={`pd-mm-pill pd-mm-pill--${kind}`}
      data-pill-kind={kind}
      title={title}
      data-testid={rest['data-testid']}
    >
      {glyph}
      {children}
    </span>
  );
}

/** Human-readable title per speed method (hovered on the pill). */
const SPEC_TITLE: Record<SpecMethod, string> = {
  mtp: 'Multi-token prediction (faster decode)',
  eagle3: 'EAGLE-3 speculative decoding (faster)',
  dflash: 'DFlash speculative decoding (faster)',
  dspark: 'DSpark speculative decoding (faster; the successor to DFlash)',
};

/** A colored speed-method pill (MTP / DFlash / EAGLE-3). The `data-pill-kind`
 * matches the method so each hue reads at a glance. */
export function SpecPill({ method }: { method: SpecMethod }) {
  return (
    <ModelTag kind={method} title={SPEC_TITLE[method]}>
      {VARIANT_LABEL[method]}
    </ModelTag>
  );
}
