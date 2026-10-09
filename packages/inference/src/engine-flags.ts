/**
 * EVERY FLAG AN ENGINE HAS, read from the engine itself.
 *
 * The user: "expand the advanced settings … to expose absolutely everything in an
 * organized good gui manner, this includes first and foremost llamacpp …
 * llamacpp has a lot of settings and usability now also, popular ones are
 * 'reasoning message' and reasoning budget, but there's a lot a lot a lot that
 * some people like and I don't want the pasting the command to be the only
 * option to get some setting they want for 99% of people."
 *
 * A hand-written list of llama-server's flags would be out of date at the next
 * pin bump and incomplete on the day it was written (b10603 prints 253 of
 * them). So the list is what `llama-server --help` prints, parsed: the flags
 * and their aliases, the argument placeholder (which decides the control), the
 * default, the env var, the section llama.cpp itself files it under. The MLX
 * engines print argparse help, which is a different shape with the same
 * information. Both parsers are pure and tested against captured fixtures.
 *
 * On top of the raw list sits a CATEGORY map — llama.cpp's own sections are
 * three ("common", "sampling", "speculative", "example-specific") and "common"
 * holds 150 flags — plus the set of flags Bobble manages itself (the model
 * path, the port, the context…) so the GUI can say "Bobble sets this" rather
 * than let a user break the launch by accident.
 */

export type FlagControl =
  | { kind: 'switch' }
  | { kind: 'number' }
  | { kind: 'text' }
  | { kind: 'select'; options: readonly string[] }
  | { kind: 'path' };

export interface EngineFlag {
  /** The long form used as the key (`--ctx-size`); the first long flag, else the first. */
  readonly key: string;
  /** Every spelling llama.cpp accepts, in the order printed (`-c`, `--ctx-size`). */
  readonly aliases: readonly string[];
  /** The argument placeholder as printed (`N`, `<0|1>`, `[on|off|auto]`), or null for a bare switch. */
  readonly placeholder: string | null;
  readonly control: FlagControl;
  readonly description: string;
  readonly defaultValue?: string;
  readonly env?: string;
  /** The engine's own section (`common`, `sampling`, `speculative`, `server`…). */
  readonly section: string;
  /** Bobble's category for the GUI (see categorize). */
  readonly category: string;
}

// ── llama.cpp `--help` ───────────────────────────────────────────────────────

const SECTION_RE = /^-{3,}\s*(.+?)\s+params\s*-{3,}$/;

/** Split `-c,    --ctx-size N` into flags and the placeholder that follows them. */
function splitFlagSpec(spec: string): { aliases: string[]; placeholder: string | null } {
  const aliases: string[] = [];
  const rest: string[] = [];
  for (const raw of spec.trim().split(/\s+/)) {
    if (raw.length === 0) continue;
    const token = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    if (token.startsWith('-') && rest.length === 0) aliases.push(token);
    else rest.push(raw);
  }
  return { aliases, placeholder: rest.length > 0 ? rest.join(' ') : null };
}

/**
 * Where the description starts on a flag line: the first run of two or more
 * spaces that does NOT follow a comma. `-c,    --ctx-size N   size of…` pads
 * after the comma too, so the first wide gap is inside the flag list.
 */
function descriptionGap(line: string): number {
  const re = /\s{2,}/g;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    if (!line.slice(0, m.index).endsWith(',')) return m.index;
    m = re.exec(line);
  }
  return -1;
}

/** `N0,N1,N2` / `TOOL1,TOOL2`: one stem, consecutive numbers — a list template, not choices. */
function numberedRun(tokens: readonly string[]): boolean {
  if (tokens.length < 2) return false;
  const parts = tokens.map((t) => t.match(/^([A-Za-z]+)(\d+)$/));
  if (parts.some((m) => m === null)) return false;
  const stem = parts[0]?.[1];
  const first = Number(parts[0]?.[2]);
  return parts.every((m, i) => m?.[1] === stem && Number(m?.[2]) === first + i);
}

function controlFor(placeholder: string | null, description: string): FlagControl {
  if (placeholder === null) return { kind: 'switch' };
  const p = placeholder.trim();
  // `<0|1>`, `[on|off|auto]`, `{a,b}` and a bare `a,b,c` list are enumerations.
  const enumMatch = p.match(/^[<[{]?([^<>[\]{}]+)[>\]}]?$/);
  if (enumMatch !== null) {
    const body = enumMatch[1] ?? '';
    if (body.includes('|') && !/[a-z]{2,}\.\w+/.test(body)) {
      const options = body.split('|').map((o) => o.trim());
      if (options.length >= 2 && options.every((o) => /^[\w.+-]+$/.test(o))) {
        return { kind: 'select', options };
      }
    }
    // `none,draft-simple,…` (llama.cpp lists the spec types inline) and
    // `{none mean cls last rank}` (a braced, space-separated set).
    // — but `N0,N1,N2,...` / `<dev1,dev2,..>` / `TOOL1,TOOL2,...` describe a
    // comma-separated LIST the user types, not a choice: an ellipsis token or a
    // numbered run of the same stem means text.
    const tokens = body.split(/[,\s]+/).map((o) => o.trim());
    const isList = tokens.some((t) => /^\.{2,}$/.test(t)) || numberedRun(tokens);
    if (
      !isList &&
      /^[\w.+-]+(?:[,\s]+[\w.+-]+)+$/.test(body) &&
      (body.includes(',') || p.startsWith('{'))
    ) {
      return { kind: 'select', options: tokens };
    }
  }
  // "allowed values: f32, f16, bf16, q8_0, …" in the description.
  const allowed = description.match(/allowed values:\s*([^\n(]+)/i);
  if (allowed !== null) {
    const options = (allowed[1] ?? '')
      .split(/[,\s]+/)
      .map((o) => o.trim())
      .filter((o) => /^[\w.+-]+$/.test(o));
    if (options.length >= 2) return { kind: 'select', options };
  }
  // `--chat-template JINJA_TEMPLATE` enumerates llama.cpp's built-in templates
  // ("list of built-in templates: bailing, …"); a name from that list is what
  // the flag is for, so it is a select. (A custom template goes through the
  // file flag, which is a path and keeps the list out of its description.)
  const builtIns = builtInList(description);
  if (builtIns !== null && !/FILE/.test(p)) return { kind: 'select', options: builtIns };
  // "one of: - none: … - deepseek: … - deepseek-legacy: …" (llama.cpp's
  // bulleted enumerations, `--reasoning-format`, `--split-mode`); the default
  // is added when the bullets leave it out ("(default: auto)").
  const oneOf = description.match(/one of:\s*((?:-\s+[\w.-]+(?:\s+\(default\))?:.*?)+)$/s);
  if (oneOf !== null) {
    const options = [
      ...(oneOf[1] ?? '').matchAll(/(?:^|\s)-\s+([\w.-]+)(?:\s+\(default\))?:/g),
    ].map((m) => m[1] ?? '');
    const def = description.match(/\(default:\s*([\w.-]+)\)/)?.[1];
    if (def !== undefined && !options.includes(def)) options.push(def);
    if (options.length >= 2) return { kind: 'select', options };
  }
  // A bare word placeholder (`LEVEL`) explained by quoted words ('minimal',
  // 'low', 'medium', …) is an enumeration too.
  if (/^[A-Z_]+$/.test(p)) {
    const quoted = [...description.matchAll(/'([\w.-]+)'/g)].map((m) => m[1] ?? '');
    const options = [...new Set(quoted)];
    if (options.length >= 3) return { kind: 'select', options };
  }
  if (/^(N|SEED|PORT|K|VALUE|SIZE|MB|BYTES|INT)$/i.test(p) || /^<?\d+(\.\.\.\d+)?>?$/.test(p)) {
    return { kind: 'number' };
  }
  if (
    /^(FNAME|FILE|PATH|DIR|DIRECTORY|MODEL_DIR)$/i.test(p) ||
    (/\bfile\b/i.test(description) && /FNAME|FILE/.test(p))
  ) {
    return { kind: 'path' };
  }
  return { kind: 'text' };
}

/** The names after "list of built-in templates:", when a description carries one. */
function builtInList(description: string): string[] | null {
  const m = description.match(/list of built-in templates:\s*([\w.,\s-]+)/i);
  if (m === null) return null;
  const options = (m[1] ?? '')
    .split(/[,\s]+/)
    .map((o) => o.trim())
    .filter((o) => /^[\w.-]+$/.test(o));
  return options.length >= 2 ? options : null;
}

function extractMeta(description: string): { text: string; defaultValue?: string; env?: string } {
  let text = description;
  // The built-in template list is an enumeration, not prose: it becomes the
  // control's options (see controlFor) and is dropped from the text.
  const list = text.match(/\s*list of built-in templates:\s*[\w.,\s-]+/i);
  const listRemoved = list !== null && builtInList(text) !== null;
  if (listRemoved) text = text.replace(list[0], ' ');
  let defaultValue: string | undefined;
  let env: string | undefined;
  const envMatch = text.match(/\(env:\s*([A-Z0-9_]+)\)/);
  if (envMatch !== null) {
    env = envMatch[1];
    text = text.replace(envMatch[0], '');
  }
  const defMatch = text.match(/\(default:\s*([^()]*(?:\([^()]*\)[^()]*)*)\)/);
  if (defMatch !== null) {
    defaultValue = (defMatch[1] ?? '').trim();
    text = text.replace(defMatch[0], '');
  }
  text = text.replace(/\s+/g, ' ').trim();
  // The list used to follow a colon; without it the colon dangles.
  if (listRemoved) text = text.replace(/:$/, '');
  return { text, defaultValue, env };
}

/**
 * Parse `llama-server --help`. Each flag line starts with `-`; a description
 * follows after two or more spaces, or on the next (indented) line when the
 * flag list fills the column; further indented lines continue it.
 */
export function parseLlamaHelp(help: string): EngineFlag[] {
  const out: EngineFlag[] = [];
  let section = 'common';
  let current: { aliases: string[]; placeholder: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    const description = current.lines.join(' ');
    const meta = extractMeta(description);
    const key = current.aliases.find((a) => a.startsWith('--')) ?? current.aliases[0] ?? '';
    if (key.length > 0 && key !== '--help' && key !== '--usage' && key !== '--version') {
      out.push({
        key,
        aliases: current.aliases,
        placeholder: current.placeholder,
        control: controlFor(current.placeholder, description),
        description: meta.text,
        ...(meta.defaultValue !== undefined ? { defaultValue: meta.defaultValue } : {}),
        ...(meta.env !== undefined ? { env: meta.env } : {}),
        section,
        category: categorize(key, section),
      });
    }
    current = null;
  };
  for (const rawLine of help.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const sec = line.match(SECTION_RE);
    if (sec !== null) {
      flush();
      section = (sec[1] ?? 'common').replace(/^example-specific$/, 'server');
      continue;
    }
    if (line.startsWith('-')) {
      flush();
      const gap = descriptionGap(line);
      const spec = gap === -1 ? line : line.slice(0, gap);
      const desc = gap === -1 ? '' : line.slice(gap).trim();
      const { aliases, placeholder } = splitFlagSpec(spec);
      current = { aliases, placeholder, lines: desc.length > 0 ? [desc] : [] };
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) {
      current.lines.push(line.trim());
      continue;
    }
    if (line.trim() === '') continue;
  }
  flush();
  return out;
}

// ── argparse `--help` (the MLX engines) ──────────────────────────────────────

/**
 * Parse Python argparse help: `  --flag METAVAR, -f METAVAR` lines under
 * `options:` (and a positional block), descriptions on the same line after a
 * wide gap or on the following, deeper-indented lines. `{a,b}` is a choice.
 */
/**
 * The default an argparse help sentence states. The parenthesised form first
 * — "Default max tokens for generation (default: 32768)." used to yield
 * "max tokens for generation (default: 32768)" because a bare "Default …"
 * matched earlier in the sentence — then the bare form, cut at the sentence's
 * own punctuation so "(R15 #300, default: bf16)" gives "bf16", not "bf16)".
 */
export function argparseDefault(description: string): string | undefined {
  const paren = description.match(/\(default:\s*([^()]*(?:\([^()]*\)[^()]*)*)\)/i);
  if (paren?.[1] !== undefined) return paren[1].trim();
  const bare = description.match(/\b[Dd]efault:?\s+([^.;,)]+)/);
  return bare?.[1]?.trim();
}

export function parseArgparseHelp(help: string): EngineFlag[] {
  const out: EngineFlag[] = [];
  let section = 'options';
  let current: { aliases: string[]; placeholder: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    const description = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const key = current.aliases.find((a) => a.startsWith('--')) ?? current.aliases[0] ?? '';
    if (key.length > 0 && key !== '--help') {
      const defaultValue = argparseDefault(description);
      out.push({
        key,
        aliases: current.aliases,
        placeholder: current.placeholder,
        control: controlFor(current.placeholder, description),
        description,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        section,
        category: categorize(key, section),
      });
    }
    current = null;
  };
  for (const rawLine of help.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const header = line.match(/^([A-Za-z][\w -]*):$/);
    if (header !== null) {
      flush();
      section = (header[1] ?? 'options').toLowerCase();
      continue;
    }
    const flagLine = line.match(/^\s{1,3}(-\S.*)$/);
    if (flagLine !== null) {
      flush();
      const body = flagLine[1] ?? '';
      const gap = body.search(/\s{2,}/);
      const spec = gap === -1 ? body : body.slice(0, gap);
      const desc = gap === -1 ? '' : body.slice(gap).trim();
      const aliases: string[] = [];
      let placeholder: string | null = null;
      for (const part of spec.split(/,\s*(?=-)/)) {
        const [flag, ...rest] = part.trim().split(/\s+/);
        if (flag?.startsWith('-')) aliases.push(flag);
        if (rest.length > 0 && placeholder === null) placeholder = rest.join(' ');
      }
      current = { aliases, placeholder, lines: desc.length > 0 ? [desc] : [] };
      continue;
    }
    if (current !== null && /^\s{4,}\S/.test(line)) {
      current.lines.push(line.trim());
      continue;
    }
    if (line.trim() === '' || section === 'usage') continue;
  }
  flush();
  return out;
}

// ── categories ───────────────────────────────────────────────────────────────

/** The GUI's groups, in the order the panel shows them. */
export const FLAG_CATEGORIES = [
  'Model & context',
  'Reasoning & chat',
  'Speculative decoding',
  'Sampling',
  'Memory & performance',
  'Multimodal',
  'Adapters',
  'Server & API',
  'Other',
] as const;
export type FlagCategory = (typeof FLAG_CATEGORIES)[number];

const RULES: ReadonlyArray<readonly [RegExp, FlagCategory]> = [
  [/spec|draft|ngram|-md$|-hfd|-cd$|-ngld|eagle|mtp/, 'Speculative decoding'],
  [
    /reasoning|think|chat-template|jinja|system-prompt|template|-sp$|special|no-context-shift|swa/,
    'Reasoning & chat',
  ],
  [/mmproj|image|audio|vision|video|mm-/, 'Multimodal'],
  [/lora|control-vector|adapter/, 'Adapters'],
  [
    /host|port|api|slot|metrics|timeout|cors|ssl|webui|embedding|rerank|props|threads-http|log|verbos|alias|path$|no-webui|cache-reuse|cache-ram|reuse|save|load|idle|prefill-assistant|pooling|parallel|cont-batching|kv-unified|models-|router|no-models|max-model|sleep|models$/,
    'Server & API',
  ],
  [
    /thread|cpu|prio|poll|batch|ubatch|gpu|ngl|device|split|tensor|main-gpu|mlock|mmap|numa|flash|-fa$|cache-type|kv|offload|defrag|repack|no-op|override|fit|warmup|no-perf|check-tensors|direct-io|cpu-moe|n-cpu-moe|extra-buft/,
    'Memory & performance',
  ],
];

/** Bobble's category for a flag: the section decides sampling, rules decide the rest. */
export function categorize(key: string, section: string): FlagCategory {
  if (section === 'sampling') return 'Sampling';
  if (section === 'speculative') return 'Speculative decoding';
  const k = key.toLowerCase();
  for (const [re, cat] of RULES) if (re.test(k)) return cat;
  if (section === 'server') return 'Server & API';
  if (
    /ctx|model|predict|keep|rope|yarn|seed|escape|no-escape|hf-|-m$|-hf|file|prompt|verbose-prompt|version|completion|cache-list|escape|grp-attn|chunks|n-|no-|-n$|-c$|offline|jinja/.test(
      k,
    )
  ) {
    return 'Model & context';
  }
  return 'Other';
}

/**
 * Flags Bobble writes itself on every llama.cpp launch. A user value for one
 * of these is shown as an override with a warning rather than silently
 * doubled; the first three are refused outright — a launch cannot survive a
 * different model path, host or port than the supervisor is watching.
 */
export const MANAGED_LLAMA_FLAGS: Readonly<Record<string, 'refused' | 'override'>> = {
  '--model': 'refused',
  '-m': 'refused',
  '--host': 'refused',
  '--port': 'refused',
  '--ctx-size': 'override',
  '-c': 'override',
  '--parallel': 'override',
  '-np': 'override',
  '--mmproj': 'override',
  '--spec-type': 'override',
  '--model-draft': 'override',
  '-md': 'override',
  '--spec-draft-n-max': 'override',
  '--chat-template-file': 'override',
  '--reasoning-preserve': 'override',
  '--reasoning-budget': 'override',
  '--reasoning-budget-message': 'override',
  '--temp': 'override',
  '--top-p': 'override',
  '--top-k': 'override',
  '--min-p': 'override',
  '--presence-penalty': 'override',
  '--repeat-penalty': 'override',
  '--dry-multiplier': 'override',
  '--dry-base': 'override',
  '--dry-allowed-length': 'override',
  '--dry-penalty-last-n': 'override',
  '--dry-sequence-breaker': 'override',
  '--cache-type-k': 'override',
  '--cache-type-v': 'override',
  '-fa': 'override',
  '--flash-attn': 'override',
  '--threads': 'override',
  '-t': 'override',
  '--no-kv-offload': 'override',
};

// ── user values → argv, and a pasted command → user values ───────────────────

export type FlagValue = string | number | boolean;

/**
 * The user's flag settings, keyed by the flag's `key`. `false` on a switch
 * means "leave it off" and produces nothing; a string/number produces
 * `--flag value`.
 */
export type FlagValues = Readonly<Record<string, FlagValue>>;

/** Turn user values into argv, skipping the refused flags. */
export function flagsToArgs(
  values: FlagValues,
  opts: { readonly refused?: readonly string[] } = {},
): { args: string[]; refused: string[] } {
  const refusedSet = new Set(opts.refused ?? []);
  const args: string[] = [];
  const refused: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (refusedSet.has(key)) {
      refused.push(key);
      continue;
    }
    if (value === false) continue;
    if (value === true) {
      args.push(key);
      continue;
    }
    const s = String(value);
    if (s.trim() === '') continue;
    args.push(key, s);
  }
  return { args, refused };
}

/** Split a shell-ish command line into tokens, honouring quotes and backslashes. */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        cur += line[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1] ?? '';
      if (next === '\n') {
        i++;
        continue;
      }
      cur += next;
      i++;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur.length > 0) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur.length > 0) tokens.push(cur);
  return tokens;
}

export interface ParsedCommandFlag {
  readonly flag: string;
  readonly value: string | null;
  /** The catalogue entry it matched (by alias), when the engine knows it. */
  readonly known?: EngineFlag;
  /** Bobble writes this one itself. */
  readonly managed?: 'refused' | 'override';
}

/**
 * Turn a pasted `llama-server -m x.gguf -c 8192 --jinja …` into flag rows the
 * user can tick. `--flag=value` is split; a value is taken only when the flag is
 * known to want one (or is unknown and the next token is not a flag).
 */
export function parseCommandLine(
  line: string,
  known: readonly EngineFlag[],
  managed: Readonly<Record<string, 'refused' | 'override'>> = MANAGED_LLAMA_FLAGS,
): ParsedCommandFlag[] {
  const byAlias = new Map<string, EngineFlag>();
  for (const f of known) for (const a of f.aliases) byAlias.set(a, f);
  const tokens = tokenizeCommand(line.replace(/\\\r?\n/g, ' '));
  const out: ParsedCommandFlag[] = [];
  let i = 0;
  // Skip the program (`llama-server`, `./build/bin/llama-server`, `sudo`, env=…).
  while (i < tokens.length && !(tokens[i] ?? '').startsWith('-')) i++;
  for (; i < tokens.length; i++) {
    let token = tokens[i] ?? '';
    if (!token.startsWith('-')) continue;
    let value: string | null = null;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0) {
      value = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const k = byAlias.get(token);
    const wantsValue = k !== undefined ? k.placeholder !== null : true;
    if (value === null && wantsValue) {
      const next = tokens[i + 1];
      if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
        value = next;
        i++;
      }
    }
    const canonical = k?.key ?? token;
    out.push({
      flag: canonical,
      value,
      ...(k !== undefined ? { known: k } : {}),
      ...(managed[canonical] !== undefined
        ? { managed: managed[canonical] }
        : managed[token] !== undefined
          ? { managed: managed[token] }
          : {}),
    });
  }
  return out;
}

/** Group flags by category in the panel's order, dropping empty groups. */
export function groupFlags(
  flags: readonly EngineFlag[],
): Array<{ category: string; flags: EngineFlag[] }> {
  const groups = new Map<string, EngineFlag[]>();
  for (const f of flags) {
    const list = groups.get(f.category) ?? [];
    list.push(f);
    groups.set(f.category, list);
  }
  const ordered: Array<{ category: string; flags: EngineFlag[] }> = [];
  for (const c of FLAG_CATEGORIES) {
    const list = groups.get(c);
    if (list !== undefined && list.length > 0) ordered.push({ category: c, flags: list });
    groups.delete(c);
  }
  for (const [category, list] of groups) ordered.push({ category, flags: list });
  return ordered;
}

/**
 * A short fingerprint of a launch configuration, the same on both sides of
 * the IPC boundary: the supervisor stamps the one it launched with on the
 * status, the panel fingerprints its draft, and Apply lights up when they
 * differ. Keys are sorted so object order cannot fake a change.
 */
export function configFingerprint(config: unknown): string {
  const canonical = JSON.stringify(config, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
