/**
 * PORTABLE KNOBS — the handful of engine settings that mean the same thing on
 * every engine, kept ONCE and spelled out in each engine's own flag at launch.
 *
 * The user (2026-09-13): "ensure settings and such transfer between engines as
 * seamlessly as possible and are removed/greyed out if unsupported by engine,
 * keeping preferences saved."
 *
 * Every engine's settings tab is that engine's own `--help`, so a context
 * window set as `--ctx-size 32768` on llama.cpp used to stay there: switch to
 * mlx-dspark and the same intent is `--context-window 32768`, on dflash-mlx
 * `--dflash-max-ctx`, on vLLM `--max-model-len` — and on mlx-lm there is no
 * such flag at all. A user should say "32k of context" once.
 *
 * So a knob is a meaning with a per-engine spelling. The value lives in
 * settings (`portableKnobs`), the launch expands it into the engine's flag(s),
 * an engine's own explicit flag for the same thing still wins (it is the more
 * specific instruction), and an engine that has no spelling simply gets
 * nothing — the value stays saved for the engines that do. When the knob has
 * no value of its own, the launch looks for the same meaning among the flags
 * the user set on OTHER engines, so a setting made before this existed still
 * carries across.
 *
 * MEASURED from the installed engines' `--help` (2026-09-13): the spellings
 * below are the flags as they print, with their units. Where an engine's flag
 * means something subtly different (mlx-dspark's `--prefix-cache-max-ram-mb`
 * is a spill threshold that needs a directory; omlx's `--hot-cache-max-size`
 * takes '8GB' strings of an unstated grammar) the knob is honestly UNSUPPORTED
 * there rather than approximated.
 *
 * Pure and tested: no I/O, no Electron.
 */

export type KnobValue = string | number | boolean;
export type FlagPairs = Record<string, KnobValue>;

export type KnobEngine =
  | 'llamacpp'
  | 'mlx-lm'
  | 'rapid-mlx'
  | 'dflash-mlx'
  | 'mlx-dspark'
  | 'omlx'
  | 'vllm';

export const KNOB_ENGINES: readonly KnobEngine[] = [
  'llamacpp',
  'mlx-lm',
  'rapid-mlx',
  'dflash-mlx',
  'mlx-dspark',
  'omlx',
  'vllm',
];

/** How one engine spells a knob: value → its flags, and flags → the value back. */
export interface KnobSpelling {
  /** The flags this knob writes on the engine (what an explicit user flag would collide with). */
  readonly flags: readonly string[];
  /** Expand a knob value into the engine's flags. */
  readonly write: (value: KnobValue) => FlagPairs;
  /** Read the knob back out of the engine's flags (undefined when they do not set it). */
  readonly read: (flags: Readonly<FlagPairs>) => KnobValue | undefined;
  /** What is lost in translation, when something is. */
  readonly note?: string;
}

export interface PortableKnob {
  readonly id: string;
  readonly label: string;
  /** One line on what it does, in the user's terms. */
  readonly blurb: string;
  readonly control:
    | {
        readonly kind: 'number';
        readonly unit?: string;
        readonly min?: number;
        readonly step?: number;
      }
    | { readonly kind: 'select'; readonly options: readonly { value: string; label: string }[] };
  /** Engines without an entry do not have this knob. */
  readonly per: Partial<Record<KnobEngine, KnobSpelling>>;
}

const num = (v: KnobValue): number | undefined => {
  // '' and true/false are not numbers, whatever Number() says about them.
  if (typeof v === 'boolean' || (typeof v === 'string' && v.trim() === '')) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** A plain `--flag N` spelling. */
function numberFlag(flag: string, scale = 1): KnobSpelling {
  return {
    flags: [flag],
    write: (v) => {
      const n = num(v);
      return n === undefined ? {} : { [flag]: Math.round(n * scale) };
    },
    read: (flags) => {
      const raw = flags[flag];
      if (raw === undefined || typeof raw === 'boolean') return undefined;
      const n = num(raw);
      return n === undefined ? undefined : Math.round(n / scale);
    },
  };
}

const MIB = 1024 * 1024;

/** KV cache quantization: off | 8-bit | 4-bit, each engine's own grammar. */
const KV_QUANT: PortableKnob = {
  id: 'kvQuant',
  label: 'KV cache quantization',
  blurb:
    'Store the attention cache in fewer bits — half or a quarter of the memory at long context, a little slower per token',
  control: {
    kind: 'select',
    options: [
      { value: 'off', label: 'Off (16-bit)' },
      { value: '8', label: '8-bit' },
      { value: '4', label: '4-bit' },
    ],
  },
  per: {
    llamacpp: {
      flags: ['--cache-type-k', '--cache-type-v'],
      write: (v) => {
        const t = v === '8' ? 'q8_0' : v === '4' ? 'q4_0' : 'f16';
        return { '--cache-type-k': t, '--cache-type-v': t };
      },
      read: (flags) => {
        const k = flags['--cache-type-k'];
        if (typeof k !== 'string') return undefined;
        return /^q8/.test(k) ? '8' : /^q4|^iq4/.test(k) ? '4' : 'off';
      },
    },
    'rapid-mlx': {
      flags: ['--kv-cache-dtype'],
      write: (v) => ({ '--kv-cache-dtype': v === '8' ? 'int8' : v === '4' ? 'int4' : 'bf16' }),
      read: (flags) => {
        const d = flags['--kv-cache-dtype'];
        if (typeof d !== 'string') return undefined;
        return d === 'int8' ? '8' : d === 'int4' ? '4' : 'off';
      },
    },
    'dflash-mlx': {
      flags: ['--quantize-kv-cache', '--no-quantize-kv-cache'],
      write: (v): FlagPairs =>
        v === 'off' ? { '--no-quantize-kv-cache': true } : { '--quantize-kv-cache': true },
      read: (flags) =>
        flags['--quantize-kv-cache'] === true
          ? '8'
          : flags['--no-quantize-kv-cache'] === true
            ? 'off'
            : undefined,
      note: 'dflash-mlx quantizes to 8-bit only; 4-bit runs as 8-bit here',
    },
    'mlx-dspark': {
      flags: ['--kv-bits'],
      write: (v) => ({ '--kv-bits': v === '8' ? 8 : v === '4' ? 4 : 0 }),
      read: (flags) => {
        const raw = flags['--kv-bits'];
        const b = raw === undefined ? undefined : num(raw);
        return b === undefined ? undefined : b === 8 ? '8' : b === 4 ? '4' : 'off';
      },
      note: 'mlx-dspark turns off request batching while the cache is quantized',
    },
    vllm: {
      flags: ['--kv-cache-dtype'],
      write: (v): FlagPairs =>
        v === 'off' ? { '--kv-cache-dtype': 'auto' } : { '--kv-cache-dtype': 'fp8' },
      read: (flags) => {
        const d = flags['--kv-cache-dtype'];
        if (typeof d !== 'string') return undefined;
        return /fp8/.test(d) ? '8' : 'off';
      },
      note: 'vLLM has 8-bit (fp8) only; 4-bit runs as 8-bit there',
    },
  },
};

export const PORTABLE_KNOBS: readonly PortableKnob[] = [
  {
    id: 'context',
    label: 'Context window',
    blurb: 'How many tokens of conversation the model keeps in view',
    control: { kind: 'number', unit: 'tokens', min: 512, step: 1024 },
    per: {
      llamacpp: numberFlag('--ctx-size'),
      'mlx-dspark': numberFlag('--context-window'),
      'dflash-mlx': numberFlag('--dflash-max-ctx'),
      vllm: numberFlag('--max-model-len'),
    },
  },
  {
    id: 'maxTokens',
    label: 'Max reply length',
    blurb: 'The most tokens a single reply may run to when the request does not say',
    control: { kind: 'number', unit: 'tokens', min: 16, step: 256 },
    per: {
      llamacpp: numberFlag('--n-predict'),
      'mlx-lm': numberFlag('--max-tokens'),
      'rapid-mlx': numberFlag('--max-tokens'),
      'dflash-mlx': numberFlag('--max-tokens'),
      'mlx-dspark': numberFlag('--default-max-tokens'),
    },
  },
  KV_QUANT,
  {
    id: 'prefillChunk',
    label: 'Prefill chunk',
    blurb: 'How many prompt tokens are processed per step — bigger is faster and uses more memory',
    control: { kind: 'number', unit: 'tokens', min: 64, step: 256 },
    per: {
      llamacpp: numberFlag('--batch-size'),
      'mlx-lm': numberFlag('--prefill-step-size'),
      'rapid-mlx': numberFlag('--prefill-step-size'),
      'dflash-mlx': numberFlag('--prefill-step-size'),
    },
  },
  {
    id: 'parallel',
    label: 'Parallel requests',
    blurb: 'How many requests the server works on at once',
    control: { kind: 'number', min: 1, step: 1 },
    per: {
      llamacpp: numberFlag('--parallel'),
      'mlx-lm': numberFlag('--decode-concurrency'),
      'rapid-mlx': numberFlag('--max-num-seqs'),
      'mlx-dspark': numberFlag('--max-batch'),
      omlx: numberFlag('--max-concurrent-requests'),
      vllm: numberFlag('--max-num-seqs'),
    },
  },
  {
    id: 'promptCacheMB',
    label: 'Prompt cache',
    blurb:
      'Memory kept for remembering earlier prompts so a follow-up does not re-read the whole conversation',
    control: { kind: 'number', unit: 'MB', min: 0, step: 512 },
    per: {
      llamacpp: numberFlag('--cache-ram'),
      'mlx-lm': numberFlag('--prompt-cache-bytes', MIB),
      'rapid-mlx': numberFlag('--cache-memory-mb'),
      'dflash-mlx': numberFlag('--prefix-cache-max-bytes', MIB),
    },
  },
];

export function knobById(id: string): PortableKnob | undefined {
  return PORTABLE_KNOBS.find((k) => k.id === id);
}

/** The engines that have a spelling for this knob. */
export function knobEngines(knob: PortableKnob): KnobEngine[] {
  return KNOB_ENGINES.filter((e) => knob.per[e] !== undefined);
}

export interface KnobResolution {
  readonly value: KnobValue;
  /** `shared` when set as a knob; an engine id when read out of that engine's own flags. */
  readonly source: 'shared' | KnobEngine;
}

/**
 * The value a knob has for a launch on `engine`: the shared value when there
 * is one, else the same meaning read from another engine's explicit flags —
 * the engine's own flags first (they are what that engine would run with
 * anyway), then the others in a fixed order so the answer is stable.
 */
export function resolveKnob(
  knob: PortableKnob,
  ctx: {
    readonly knobs: Readonly<Record<string, KnobValue>>;
    readonly engineLaunch: Readonly<Record<string, { readonly flags: Readonly<FlagPairs> }>>;
    readonly engine?: KnobEngine | string;
  },
): KnobResolution | null {
  const shared = ctx.knobs[knob.id];
  if (shared !== undefined && shared !== '') return { value: shared, source: 'shared' };
  const order: KnobEngine[] = [
    ...(ctx.engine !== undefined && KNOB_ENGINES.includes(ctx.engine as KnobEngine)
      ? [ctx.engine as KnobEngine]
      : []),
    ...KNOB_ENGINES,
  ];
  for (const e of order) {
    const spelling = knob.per[e];
    const flags = ctx.engineLaunch[e]?.flags;
    if (spelling === undefined || flags === undefined) continue;
    const v = spelling.read(flags);
    if (v !== undefined) return { value: v, source: e };
  }
  return null;
}

/**
 * The flags a launch on `engine` gets from the knobs — every knob the engine
 * spells, resolved as above, MINUS any whose flags the engine's own explicit
 * settings already set (the explicit flag is the more specific instruction and
 * must win, so the knob does not even try).
 */
export function portableFlagsFor(
  engine: KnobEngine | string,
  ctx: {
    readonly knobs: Readonly<Record<string, KnobValue>>;
    readonly engineLaunch: Readonly<Record<string, { readonly flags: Readonly<FlagPairs> }>>;
  },
): FlagPairs {
  if (!KNOB_ENGINES.includes(engine as KnobEngine)) return {};
  const own = ctx.engineLaunch[engine]?.flags ?? {};
  const out: FlagPairs = {};
  for (const knob of PORTABLE_KNOBS) {
    const spelling = knob.per[engine as KnobEngine];
    if (spelling === undefined) continue;
    if (spelling.flags.some((f) => own[f] !== undefined)) continue;
    const r = resolveKnob(knob, { ...ctx, engine });
    if (r === null) continue;
    Object.assign(out, spelling.write(r.value));
  }
  return out;
}

/**
 * The launch config an engine actually runs with: the knobs' flags underneath
 * the engine's own. ONE function for the supervisor (which assembles argv) and
 * the panel (which fingerprints its draft), so "Apply lights up when something
 * changed" and "what changed" cannot disagree.
 */
export function effectiveLaunchConfig<
  C extends { readonly flags: Readonly<FlagPairs>; readonly rawArgs: readonly string[] },
>(
  engine: string,
  ctx: {
    readonly knobs: Readonly<Record<string, KnobValue>>;
    readonly engineLaunch: Readonly<Record<string, C>>;
  },
): { flags: FlagPairs; rawArgs: string[] } {
  const own = ctx.engineLaunch[engine];
  return {
    flags: { ...portableFlagsFor(engine, ctx), ...(own?.flags ?? {}) },
    rawArgs: [...(own?.rawArgs ?? [])],
  };
}
