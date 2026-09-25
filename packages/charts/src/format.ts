/**
 * NUMBERS AS A READER SEES THEM — values, tooltips and axis ticks (VQ-02).
 *
 * The research's chart set: revenue in "$M" read "5.6 $M" on every label, the
 * ticks carried no unit at all (a reader of the axis could not tell dollars
 * from counts), and 22,000,000 was printed in full on an axis that had room for
 * "22M". A unit is two parts — what goes before the number and what goes after
 * — and a tick is a number that has to be short.
 */

/** A unit, split into what is written before and after the number. */
export interface UnitParts {
  /** "$", "€" — written flush before the number. */
  readonly prefix: string;
  /** "%", "M", "k" flush after; " GW", " units" after a space. */
  readonly suffix: string;
  /** A word the ticks leave out ("units", "features") — too long to repeat on every tick. */
  readonly word: boolean;
}

const MAGNITUDE_WORDS: Readonly<Record<string, string>> = {
  k: 'k',
  K: 'k',
  m: 'M',
  M: 'M',
  mm: 'M',
  MM: 'M',
  mn: 'M',
  b: 'B',
  B: 'B',
  bn: 'bn',
  BN: 'bn',
  t: 'T',
  T: 'T',
  tn: 'T',
};

/** "$" → $·; "%" → ·%; "$M" → $·M; "M" → ·M; "GW" → · GW; "units" → · units (a word). */
export function unitParts(unit: string | undefined): UnitParts {
  const u = (unit ?? '').trim();
  if (u === '') return { prefix: '', suffix: '', word: false };
  if (/^[$€£¥]$/.test(u)) return { prefix: u, suffix: '', word: false };
  if (u === '%') return { prefix: '', suffix: '%', word: false };
  const money = /^([$€£¥])\s*([A-Za-z]{1,2})$/.exec(u);
  if (money?.[1] !== undefined && money[2] !== undefined) {
    const mag = MAGNITUDE_WORDS[money[2]];
    if (mag !== undefined) return { prefix: money[1], suffix: mag, word: false };
  }
  const mag = MAGNITUDE_WORDS[u];
  if (mag !== undefined) return { prefix: '', suffix: mag, word: false };
  // A short symbol-like unit rides the ticks ("GW", "kg", "ms", "°C"); a word
  // ("units", "people") is said once, not on every tick.
  return { prefix: '', suffix: ` ${u}`, word: u.length > 3 };
}

/**
 * The number, whole or compact. `scaleOf` is the magnitude that picks the
 * compact unit — for a tick, the axis' largest, so one axis reads "$0.5M, $1M,
 * $1.5M" rather than "$500,000, $1M".
 */
function body(value: number, compact: boolean, scaleOf = Math.abs(value)): string {
  const abs = Math.abs(value);
  if (compact && scaleOf >= 1e6) {
    const [div, sym] = scaleOf >= 1e12 ? [1e12, 'T'] : scaleOf >= 1e9 ? [1e9, 'B'] : [1e6, 'M'];
    const n = value / div;
    if (n === 0) return '0';
    const digits = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
    return `${Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })}${sym}`;
  }
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  if (abs >= 100) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 10) return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A minus sign goes before the currency: −$5, not $−5. */
function assemble(value: number, text: string, parts: UnitParts, withSuffix: boolean): string {
  const sign = value < 0 && text.startsWith('-') ? '-' : '';
  const digits = sign !== '' ? text.slice(1) : text;
  return `${sign}${parts.prefix}${digits}${withSuffix ? parts.suffix : ''}`;
}

/**
 * A value with its unit, for labels, tooltips and the table: "$4.2M" from
 * (4.2, "$M"), "12%", "5 GW", "19 units". The number stays whole (22,000,000):
 * a table and a tooltip are where the exact figure is read.
 */
export function formatValue(value: number, unit?: string): string {
  return assemble(value, body(value, false), unitParts(unit), true);
}

/**
 * An axis tick: the unit's prefix and its short suffix ride every tick ("$2M",
 * "40%", "20 GW"); a unit that is a word does not (it is said once, on the
 * axis). An axis reaching a million is compact throughout ("0.5M, 1M, 1.5M");
 * below that, thousands keep their comma. `axisMax` is the axis' largest |tick|.
 */
export function formatTick(value: number, unit?: string, axisMax?: number): string {
  const parts = unitParts(unit);
  const compact = parts.suffix === '' || parts.word || parts.suffix.startsWith(' ');
  // Zero needs no magnitude: "$0", not "$0M" (a percent or a unit word stays: "0%").
  const magnitude = !parts.word && /^[kMBT]$|^bn$/.test(parts.suffix);
  return assemble(
    value,
    body(value, compact, axisMax ?? Math.abs(value)),
    parts,
    !parts.word && !(value === 0 && magnitude),
  );
}
