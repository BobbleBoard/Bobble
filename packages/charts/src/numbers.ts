/**
 * READING THE NUMBERS A MODEL WRITES (VQ-02).
 *
 * The chart tool took `--values "22M, 3,100"` and drew Market 3, Today 100: the
 * thousands comma split the list and "22M" was dropped. `"$1.2M, $2.4M"` was
 * refused as "chart needs its data" — the wrong problem named. And any token it
 * could not read was silently dropped, so every value after it slid one label
 * to the left. The model had the numbers right; the system corrupted them after
 * the model had spoken.
 *
 * So, one reader for every number a chart takes:
 *
 *   - money and magnitudes: `$38k`, `$1.2M`, `22M`, `1.2B`, `3bn`, `€4.5m`,
 *     `12 million`, `$24,000`, `1.2e6`;
 *   - signs: `-5`, `−5` (a real minus), `+5`, `(5)` (accounting negative);
 *   - `12%`, `12.5 %`; a unit word after the number (`12 GW`, `3 units`);
 *   - the thousands comma, told apart from the list comma by COUNTING against
 *     the labels: "22M, 3,100" with two labels is 22,000,000 and 3,100.
 *
 * A token that is still not a number is an error that names it and says what
 * would have worked — never a silent zero, never a shift.
 */

export interface ParsedNumber {
  readonly value: number;
  /** A currency symbol written with it: $, €, £, ¥. */
  readonly currency?: string;
  /** Written as a percentage. */
  readonly percent?: boolean;
  /** A unit word written after it ("GW", "units"), when not a magnitude. */
  readonly unitWord?: string;
}

const CURRENCY = '$€£¥';
const MAGNITUDE: Readonly<Record<string, number>> = {
  k: 1e3,
  K: 1e3,
  thousand: 1e3,
  m: 1e6,
  M: 1e6,
  mm: 1e6,
  MM: 1e6,
  mn: 1e6,
  mil: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  B: 1e9,
  bn: 1e9,
  BN: 1e9,
  billion: 1e9,
  billions: 1e9,
  t: 1e12,
  T: 1e12,
  tn: 1e12,
  trillion: 1e12,
};

/** One value token → its number, or null when it is not one. */
export function parseNumber(raw: unknown): ParsedNumber | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : null;
  if (typeof raw !== 'string') return null;
  let t = raw.trim().replace(/−/g, '-'); // U+2212 MINUS SIGN
  if (t === '') return null;
  let negative = false;
  // (5) — an accounting negative.
  const paren = /^\((.+)\)$/.exec(t);
  if (paren?.[1] !== undefined) {
    negative = true;
    t = paren[1].trim();
  }
  const sign = (): void => {
    if (t.startsWith('-')) {
      negative = !negative;
      t = t.slice(1).trim();
    } else if (t.startsWith('+')) {
      t = t.slice(1).trim();
    }
  };
  sign();
  let currency: string | undefined;
  if (t !== '' && CURRENCY.includes(t[0] as string)) {
    currency = t[0];
    t = t.slice(1).trim();
    sign(); // "$-5"
  }
  // A currency symbol after the number: "5€".
  if (currency === undefined && t !== '' && CURRENCY.includes(t[t.length - 1] as string)) {
    currency = t[t.length - 1];
    t = t.slice(0, -1).trim();
  }
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  // The number itself: digits with optional thousands commas, a decimal part,
  // an exponent — then whatever is left must be a magnitude or a unit word.
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?\s*(.*)$/.exec(t);
  if (m === null || (m[1] === undefined && m[2] === undefined)) return null;
  const whole = (m[1] ?? '0').replace(/,/g, '');
  const text = `${whole}${m[2] !== undefined ? `.${m[2]}` : ''}${m[3] !== undefined ? `e${m[3]}` : ''}`;
  let value = Number(text);
  if (!Number.isFinite(value)) return null;
  const rest = (m[4] ?? '').trim();
  let unitWord: string | undefined;
  if (rest !== '') {
    const [first, ...others] = rest.split(/\s+/);
    const mag = first !== undefined ? MAGNITUDE[first] : undefined;
    if (mag !== undefined) {
      value *= mag;
      const after = others.join(' ');
      if (after !== '') {
        if (!/^[\p{L}/°][\p{L}\d/°.-]*(?:\s[\p{L}][\p{L}\d.-]*)?$/u.test(after)) return null;
        unitWord = after;
      }
    } else if (/^[\p{L}/°][\p{L}\d/°.-]*(?:\s[\p{L}][\p{L}\d.-]*)?$/u.test(rest)) {
      unitWord = rest;
    } else {
      return null;
    }
  }
  if (negative) value = -value;
  // Clean binary noise from the magnitude multiply: 1.2 × 1e6 is 1200000, not 1199999.9999998.
  value = Number(value.toPrecision(15));
  return {
    value,
    ...(currency !== undefined ? { currency } : {}),
    ...(percent ? { percent } : {}),
    ...(unitWord !== undefined ? { unitWord } : {}),
  };
}

/** What a list of values said, beyond the numbers. */
export interface ParsedList {
  readonly values: number[];
  /** The unit every value carried the same way ("$", "%", "GW"), when they all did. */
  readonly unit?: string;
}

/** Why a list could not be read — said back to the model as is. */
export class ChartDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartDataError';
  }
}

/** The forms a value may take, named in every refusal. */
export const ACCEPTED_NUMBER_FORMS =
  'a value may be written 3100, 3,100, 22M, $1.2M, 38k, 1.5B, 12.5% or -4 — one per label, separated by ", " or "; "';

/**
 * Split a written list into value tokens. A comma followed by a space, a
 * semicolon, a newline, or a run of spaces separate values; a comma between
 * digits with no space ("3,100") might be a thousands comma OR a separator
 * ("12,19,15") — `commas` decides which reading is tried.
 */
function tokens(text: string, commas: 'grouping' | 'separator'): string[] {
  const parts = text
    .split(/\s*;\s*|\n+|,\s+|\s{2,}|\s(?=[-+−(]?[$€£¥]?\d)(?<=\d\s|%\s|[kKmMbBnN]\s)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (commas === 'grouping') {
    // A comma inside a token is a thousands comma only in a valid grouping
    // (1,234 / 12,345,678); anything else ("12,19") is still a separator.
    return parts
      .flatMap((p) => (/^[^,]*\d{1,3}(?:,\d{3})+(?:\.\d+)?[^,]*$/.test(p) ? [p] : p.split(',')))
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return parts
    .flatMap((p) => p.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The one unit every parsed value shares, when they share one. */
function commonUnit(parsed: readonly ParsedNumber[]): string | undefined {
  if (parsed.length === 0) return undefined;
  const cur = parsed[0]?.currency;
  if (cur !== undefined && parsed.every((p) => p.currency === cur)) return cur;
  if (parsed.every((p) => p.percent === true)) return '%';
  const word = parsed[0]?.unitWord;
  if (word !== undefined && parsed.every((p) => p.unitWord === word)) return word;
  return undefined;
}

/**
 * A written list → its numbers. `expected` is the number of labels when known:
 * the thousands comma and the list comma are told apart by which reading gives
 * one value per label. Throws a {@link ChartDataError} for a token that is not a
 * number, and for a list that reads both ways with neither matching the labels.
 */
export function parseNumberList(input: unknown, expected?: number): ParsedList {
  if (Array.isArray(input)) {
    const parsed = input.map((v, i) => {
      const p = parseNumber(v);
      if (p === null) {
        throw new ChartDataError(
          `could not read ${JSON.stringify(v)} (value ${i + 1} of ${input.length}) as a number: ${ACCEPTED_NUMBER_FORMS}`,
        );
      }
      return p;
    });
    const unit = commonUnit(parsed);
    return { values: parsed.map((p) => p.value), ...(unit !== undefined ? { unit } : {}) };
  }
  if (typeof input === 'number') return parseNumberList([input], expected);
  if (typeof input !== 'string') return { values: [] };
  const readings = (['grouping', 'separator'] as const).map((mode) => {
    const toks = tokens(input, mode);
    const parsed = toks.map((t) => ({ t, p: parseNumber(t) }));
    return { mode, toks, parsed, bad: parsed.find((x) => x.p === null)?.t };
  });
  const [grouping, separator] = readings as [(typeof readings)[0], (typeof readings)[0]];
  const ok = readings.filter((r) => r.bad === undefined);
  let pick = ok[0];
  if (expected !== undefined && expected > 0) {
    const fits = ok.filter((r) => r.toks.length === expected);
    if (fits.length > 0) pick = fits[0];
    else if (
      ok.length === 2 &&
      grouping.toks.length !== separator.toks.length &&
      grouping.toks.length !== expected
    ) {
      throw new ChartDataError(
        `could not tell how to read ${JSON.stringify(input)}: with the commas as thousands it is ${grouping.toks.length} value${grouping.toks.length === 1 ? '' : 's'}, as separators ${separator.toks.length}, and there are ${expected} labels. Write 3100 without the comma, or separate values with "; "`,
      );
    }
  }
  if (pick === undefined) {
    const bad = grouping.bad ?? separator.bad ?? '';
    const at = grouping.toks.indexOf(bad);
    throw new ChartDataError(
      `could not read ${JSON.stringify(bad)}${at >= 0 ? ` (value ${at + 1} of ${grouping.toks.length})` : ''} as a number: ${ACCEPTED_NUMBER_FORMS}`,
    );
  }
  const parsed = pick.parsed.map((x) => x.p as ParsedNumber);
  const unit = commonUnit(parsed);
  return { values: parsed.map((p) => p.value), ...(unit !== undefined ? { unit } : {}) };
}
