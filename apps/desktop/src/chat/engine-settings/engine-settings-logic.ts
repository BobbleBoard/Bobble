/**
 * The pure half of Settings → Advanced → Engine: what the panel shows for a
 * model, which speculative methods it can offer, what "dirty" means for the
 * Apply button, and how a draft of the user's flags is edited. Tested without
 * a renderer.
 */
import type { LlmCatalogEntry, LlmStatus } from '../../../electron/ipc-contract';
import type {
  EngineFlagValue,
  EngineLaunchConfig,
  ModelSpecChoice,
} from '../../../electron/settings/settings-contract';

export type FlagValues = Record<string, EngineFlagValue>;

/** The flags most people reach for, pinned above the categories in this order. */
export const POPULAR_LLAMA_FLAGS: readonly string[] = [
  '--reasoning-budget',
  '--reasoning-budget-message',
  '--reasoning-format',
  '--ctx-size',
  '--n-gpu-layers',
  '--flash-attn',
  '--cache-type-k',
  '--cache-type-v',
  '--threads',
  '--batch-size',
  '--ubatch-size',
  '--jinja',
  '--chat-template-file',
  '--chat-template',
  '--mlock',
  '--no-mmap',
  '--cache-ram',
  '--parallel',
  '--cont-batching',
  '--n-predict',
];

/** The speculative methods the panel's bar offers, in order. */
export const SPEC_METHODS: ReadonlyArray<{
  method: ModelSpecChoice['method'];
  label: string;
  blurb: string;
}> = [
  { method: 'auto', label: 'Auto', blurb: 'What calibration chose, or the model’s default' },
  { method: 'none', label: 'Off', blurb: 'Plain decoding' },
  { method: 'mtp', label: 'MTP', blurb: 'The model’s own multi-token heads' },
  { method: 'eagle3', label: 'EAGLE-3', blurb: 'A trained draft head' },
  {
    method: 'dflash',
    label: 'DFlash',
    blurb: 'Block-diffusion drafter (DFlash2 where the head is one)',
  },
  { method: 'dspark', label: 'DSpark', blurb: 'DFlash’s successor; CUDA-first, ported' },
  { method: 'ngram', label: 'n-gram', blurb: 'Model-free, from the text so far' },
  { method: 'custom', label: 'Custom', blurb: 'Your own draft GGUF' },
];

export interface MethodAvailability {
  readonly method: ModelSpecChoice['method'];
  /** The bar can offer it: the model has this head or a drafter is catalogued. */
  readonly offered: boolean;
  /** The drafter's GGUF is on disk (or nothing needs to be). */
  readonly ready: boolean;
  /** Why it is not offered, or what would make it ready. */
  readonly note?: string;
  /** DFlash2 is a DFlash head with a different name; the bar says which one it has. */
  readonly label?: string;
}

/**
 * Which methods the bar offers for a model. the user: "only show models that are
 * supported and we have drafters picked out for already (in recommended)
 * custom is the place the user can have their own drafter picked".
 */
export function methodAvailability(
  entry: LlmCatalogEntry | undefined,
  opts: { readonly draftsOnDisk: readonly string[]; readonly specTypes: readonly string[] },
): MethodAvailability[] {
  const variants = entry?.variants ?? [];
  const has = (m: string) => variants.some((v) => v.method === m);
  const drafted = (m: string) =>
    variants.some((v) => v.method === m) && opts.draftsOnDisk.some((f) => f.includes(m));
  const supports = (t: string) => opts.specTypes.length === 0 || opts.specTypes.includes(t);
  const dflashVariant = variants.find((v) => v.method === 'dflash');
  const dflash2 = /dflash2/i.test(dflashVariant?.draftRepo ?? '');
  return SPEC_METHODS.map(({ method }) => {
    switch (method) {
      case 'auto':
      case 'none':
        return { method, offered: true, ready: true };
      case 'ngram':
        return {
          method,
          offered: supports('ngram-mod'),
          ready: true,
          ...(supports('ngram-mod')
            ? {}
            : { note: 'this llama.cpp build has no n-gram speculation' }),
        };
      case 'custom':
        return { method, offered: true, ready: true };
      case 'mtp':
        return entry?.mtp === true
          ? { method, offered: true, ready: true }
          : { method, offered: false, ready: false, note: 'this model has no MTP head' };
      case 'eagle3':
      case 'dflash':
      case 'dspark': {
        const type = `draft-${method}`;
        if (!has(method)) {
          return {
            method,
            offered: false,
            ready: false,
            note: `no ${method} drafter is catalogued for this model`,
          };
        }
        if (!supports(type)) {
          return {
            method,
            offered: false,
            ready: false,
            note: `this llama.cpp build cannot run ${method}`,
          };
        }
        const ready = drafted(method);
        return {
          method,
          offered: true,
          ready,
          ...(ready ? {} : { note: 'drafter not downloaded yet' }),
          ...(method === 'dflash' && dflash2 ? { label: 'DFlash2' } : {}),
        };
      }
      default:
        return { method, offered: false, ready: false };
    }
  });
}

/** Set, change or clear one flag in a draft of the user's values. */
export function setFlag(
  values: FlagValues,
  key: string,
  value: EngineFlagValue | null,
): FlagValues {
  const next = { ...values };
  if (value === null || value === '' || value === false) delete next[key];
  else next[key] = value;
  return next;
}

export function emptyConfig(): EngineLaunchConfig {
  return { flags: {}, rawArgs: [] };
}

/** Two configs mean the same launch. */
export function sameConfig(a: EngineLaunchConfig, b: EngineLaunchConfig): boolean {
  const ka = Object.keys(a.flags).sort();
  const kb = Object.keys(b.flags).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  if (ka.some((k) => String(a.flags[k]) !== String(b.flags[k]))) return false;
  return a.rawArgs.length === b.rawArgs.length && a.rawArgs.every((x, i) => x === b.rawArgs[i]);
}

/** A flag's value as the running server has it, read off its own argv. */
export function runningValue(status: LlmStatus, aliases: readonly string[]): string | null {
  const args = status.launchArgs ?? [];
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] ?? '';
    if (!aliases.includes(a)) continue;
    const next = args[i + 1];
    // A negative number (`--reasoning-budget -1`) is a value, not the next flag.
    return next !== undefined && (!next.startsWith('-') || /^-\d/.test(next)) ? next : 'on';
  }
  return null;
}

/** Render a command line for display: quote what needs quoting. */
export function shellJoin(command: string, args: readonly string[]): string {
  const q = (s: string) => (/^[\w./:=+@%,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return [q(command), ...args.map(q)].join(' ');
}

/** Whether a flag matches a search query, on any spelling or its description. */
export function flagMatches(
  flag: { key: string; aliases: readonly string[]; description: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    flag.key.toLowerCase().includes(q) ||
    flag.aliases.some((a) => a.toLowerCase().includes(q)) ||
    flag.description.toLowerCase().includes(q)
  );
}
