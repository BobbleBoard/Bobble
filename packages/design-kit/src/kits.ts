/**
 * THE SIX KITS, read from their data files.
 *
 * Each is a JSON file in ./kits — data, not code, so a new kit (or VQ-14's
 * saved brand) is a file, and so Python reads the very same values through
 * the export (export.ts → tools/office-gen/design_tokens.json). They are
 * parsed here once, at load: a kit file that is not a kit fails loudly the
 * first time anything imports this, naming the field, instead of a renderer
 * finding a missing colour later.
 *
 * The order is the order a picker shows them in, the default first.
 */
import boneOxblood from './kits/bone-oxblood.json';
import fog from './kits/fog.json';
import graphiteAmber from './kits/graphite-amber.json';
import paperTeal from './kits/paper-teal.json';
import sageMoss from './kits/sage-moss.json';
import slateCobalt from './kits/slate-cobalt.json';
import { type Kit, parseKit } from './schema.ts';

/**
 * The house default: the research's own house theme (the flow-diagram and
 * pitch-deck prototypes, the Tidewell exemplars) — ivory, warm ink and the
 * mark's teal (memory `pi-desktop-design-palettes`: "Paper & teal … the only
 * one that stops the app reading as System Settings").
 */
export const DEFAULT_KIT_ID = 'paper-teal';

export const KITS: readonly Kit[] = [
  paperTeal,
  fog,
  boneOxblood,
  slateCobalt,
  sageMoss,
  graphiteAmber,
].map((raw) => parseKit(raw));

export const KIT_IDS: readonly string[] = KITS.map((k) => k.id);

/** "Paper & teal", "paper_teal", "paper teal" → the kit; unknown → undefined. */
export function kitById(name: string | undefined | null): Kit | undefined {
  if (typeof name !== 'string') return undefined;
  const key = name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return KITS.find((k) => k.id === key || k.name.toLowerCase().replace(/[^a-z]+/g, '-') === key);
}

/** The named kit, or the default when the name is empty or unknown. */
export function kitOrDefault(name?: string | null): Kit {
  return kitById(name) ?? (kitById(DEFAULT_KIT_ID) as Kit);
}
