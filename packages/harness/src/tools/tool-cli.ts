/**
 * EVERY TOOL AS A COMMAND LINE — the pure core.
 *
 * the user's experiment, in his words: "all mcps, etc. are parsed and resolved into
 * a cli tool, eg. the media generation tools might become 'media' cli and then
 * the model can run --help, find out it can do media generate video/image
 * "prompt" … so any mcp, any toolset, any connector they can all be loaded at
 * once everything at the same time no performance penalty and also, I would
 * totally bet that we get near if not actual 100% tool success rate because the
 * actual tool syntax is just the one bash tool and no modern model is failing to
 * write simple bash commands these days."
 *
 * THE ARGUMENT. Today a tool is only callable if its JSON schema is in the
 * request, so the harness spends its effort deciding WHICH tools to advertise
 * this turn — a classifier, presets, a `capability` round-trip — and every one
 * of those decisions is a chance to withhold the tool the model actually needed.
 * That failure has a signature this project keeps meeting: the model says it
 * cannot do something it ships. If instead every tool is a command on PATH, the
 * advertised surface is ONE tool (`bash`) and the whole registry is discoverable
 * at zero prompt cost — `--help` is generated from the same schema the tool
 * validates against, so it cannot drift.
 *
 * WHAT THIS FILE IS. The grammar, the help text, the search and the resolution,
 * all pure and unit-tested: given a registry and an argv, which tool runs with
 * which arguments. The socket, the shims and the setting live next door in
 * `tool-cli-bridge.ts`, so everything that decides CORRECTNESS can be tested
 * without a process.
 *
 * THE GROUPS ARE NOT A NEW TAXONOMY. They are the capability registry the
 * harness already keeps — `generation` becomes `media`, `browser` stays
 * `browser` — so there is exactly one place that says which tools belong
 * together, and the CLI cannot describe a grouping the rest of the app does not.
 */

/** The subset of a JSON Schema this file reads. TypeBox emits exactly this. */
export interface CliSchema {
  readonly type?: string;
  readonly properties?: Record<string, Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: unknown;
}

/** A tool as the registry knows it. */
export interface CliTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

/** A capability group, as `capabilities.ts` already defines it. */
export interface CliGroupSpec {
  readonly name: string;
  readonly summary: string;
  readonly tools: readonly string[];
}

/** One command: `media generate image` → the `generate_image` tool. */
export interface CliCommand {
  readonly group: string;
  /** Words after the group name: ['generate','image']. */
  readonly path: readonly string[];
  readonly tool: CliTool;
}

export interface CliModel {
  readonly groups: readonly { name: string; summary: string; commands: readonly CliCommand[] }[];
}

/**
 * Capability name → the command you type.
 *
 * `generation` is `media` because that is the word for the thing being made and
 * it is what the user reached for unprompted. The rest keep their names; a
 * capability with no entry here becomes its own name with dashes flattened,
 * so a new capability gets a working CLI without touching this table.
 */
const COMMAND_NAMES: Readonly<Record<string, string>> = {
  generation: 'media',
  'web-research': 'web',
  'computer-use': 'mac',
  connectors: 'mcp',
};

export function commandNameFor(capability: string): string {
  return COMMAND_NAMES[capability] ?? capability.replace(/-/g, '');
}

/**
 * The words that follow the group name, derived from the tool's own name.
 *
 * `generate_image` under `media` is `media generate image`; `browser_click`
 * under `browser` is `browser click`, because repeating the group would make
 * you type `browser browser click`. Nothing here is hand-maintained — a tool
 * added to a capability gets a command by existing.
 */
/**
 * Tools whose path is STATED because deriving it reads badly.
 *
 * `update_plan` under the `plan` group would derive to `plan update plan`. The
 * derivation is right for the ninety percent and this is the exception, so it
 * is written down rather than made into a cleverer rule.
 */
const COMMAND_PATH_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  /*
   * THE FOUR OF `coordinate`, NAMED FOR THE GROUP THEY ARE NOW IN.
   *
   * These were written when each lived in its own one-command group, so
   * `plan update` and `team spawn` read correctly and `update`/`spawn` were the
   * right tails. Under one `coordinate` group the same tails read wrong:
   * "coordinate update" has lost the word plan, and the underived
   * `ask_user` gives "coordinate ask user", which is a mouthful for the most
   * ordinary thing here.
   *
   * MEASURED against the app, which is how this was caught at all: the system
   * prompt was hand-written to say `coordinate plan` and `coordinate delegate`,
   * and `coordinate --help` answered with `coordinate update` and `coordinate
   * spawn`. A prompt naming commands that do not exist is the same
   * false-availability failure as naming a tool that is not advertised.
   */
  ask_user: ['ask'],
  // `machine spotlight search` reads as three nouns; `machine search` is the
  // thing it does. Same for the other two, which would otherwise repeat their
  // group or their verb.
  spotlight_search: ['search'],
  // `machine python run` repeats itself; running Python IS the command.
  python_run: ['python'],
  create_scheduled_task: ['schedule'],
  update_plan: ['plan'],
  spawn_subagent: ['delegate'],
  talk_to_manager: ['manager'],
  /* the user: "svg <optional prompt> --image <optional reference image path(s)>".
     The group is `svg` and its one tool has no sub-word, so the command is the
     group name and the prompt is the positional. */
  generate_svg: [],
  /* The same shape: the `chart` group's one tool IS the command —
     `chart bar "Units Sold by Year" --labels … --values …`. */
  chart: [],
  /* …and `diagram "Order fulfilment" --source '<mermaid>'`; its sibling
     derives to `diagram edit`. */
  diagram: [],
  /* …and `math lesson.math.json` — one command, the spec its argument. */
  math: [],
  /* `3d generate` / `3d refine` — derived, `generate_3d` under `3d` would
     read "3d generate 3d" (the group name is a suffix here, not a prefix). */
  generate_3d: ['generate'],
  refine_3d: ['refine'],
};

export function pathFor(group: string, toolName: string): string[] {
  const override = COMMAND_PATH_OVERRIDES[toolName];
  if (override !== undefined) return [...override];
  const parts = toolName.split('_').filter((p) => p.length > 0);
  if (parts.length > 1 && (parts[0] === group || parts[0] === `${group}s`)) return parts.slice(1);
  return parts;
}

/** Build the command surface from the capability groups + what is registered. */
export function buildCli(specs: readonly CliGroupSpec[], available: readonly CliTool[]): CliModel {
  const byName = new Map(available.map((t) => [t.name, t] as const));
  const groups = specs
    .map((spec) => {
      const group = commandNameFor(spec.name);
      const commands = spec.tools
        .map((n) => byName.get(n))
        .filter((t): t is CliTool => t !== undefined)
        .map((tool) => ({ group, path: pathFor(group, tool.name), tool }));
      return { name: group, summary: spec.summary, commands };
    })
    /* A group whose tools this build does not register is not a group. The
       alternative — listing a command that answers "unknown tool" — is the
       false-availability failure this whole experiment exists to remove. */
    .filter((g) => g.commands.length > 0);
  return { groups };
}

// ── argv ─────────────────────────────────────────────────────────────────────

export interface ParsedArgv {
  readonly words: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly positionals: readonly string[];
  readonly wantsHelp: boolean;
}

/**
 * Split an argv into leading words, `--flags` and positionals.
 *
 * Deliberately permissive: `--key value`, `--key=value` and `-k value` all work,
 * and a bare word after the command path is kept as a positional. A small model
 * writing `media generate image "a red fox"` is not making a mistake — it is
 * writing the most natural form of the line, and refusing it on a technicality
 * would be measuring our parser rather than the model.
 */
/*
 * TEMPLATE DEBRIS IS NOT AN ARGUMENT. MEASURED (4B on rapid-mlx, the visual
 * suite, 2 of 15 tasks): `coordinate present --path=index.html "</parameter"`
 * — the XML tool template's closing tag, read back into the command as a word
 * of its own. There it went nowhere; after `svg "a fox"` it would have joined
 * the prompt. A word that is only a template tag, or a tag glued to the end of
 * a word, was never typed as an argument (provider-llamacpp's
 * scrubTemplateDebris is the same rule for a structured call's keys).
 */
const DEBRIS_WORD = /^<\/?(?:parameter|function|tool_call)\b[^>]*>?$/i;
const DEBRIS_TAIL = /<\/(?:parameter|function|tool_call)>?$/i;

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const words: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let wantsHelp = false;
  let seenFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = (argv[i] ?? '').trim();
    if (DEBRIS_WORD.test(raw)) continue;
    const a = raw === '' ? (argv[i] ?? '') : (argv[i] ?? '').replace(DEBRIS_TAIL, '');
    if (a === '--help' || a === '-h' || a === 'help') {
      wantsHelp = true;
      continue;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a))) {
      seenFlag = true;
      const body = a.replace(/^-+/, '');
      const eq = body.indexOf('=');
      if (eq > 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (seenFlag) positionals.push(a);
    else words.push(a);
  }
  /* Words are the command path only while they could still BE one; once a flag
     has appeared everything else is a value. The split is decided by the
     resolver, which knows how deep this group's commands go. */
  return { words, flags, positionals, wantsHelp };
}

/**
 * Coerce flag strings into what the schema asks for.
 *
 * Unknown keys pass through untouched rather than being dropped: a tool that
 * accepts more than it documents still works, and a typo reaches the tool as a
 * typo — which produces a real error message instead of a silent no-op.
 */
/**
 * THE WORD A MODEL REACHES FOR, POINTING AT THE FLAG WE ACTUALLY HAVE.
 *
 * the user: "why don't you add a flag to snapshot to force a visual eg snapshot
 * --image/visual". The flag exists — `--screenshot` — and that is exactly the
 * problem: an unknown flag is passed through untouched (see below, which is
 * right for a typo that should reach the tool as an error), but a BOOLEAN typo
 * errors at nothing. `mac snapshot --image` silently produced no picture and no
 * complaint, which is the worst of both.
 *
 * Aliases are applied only when the real property exists on this tool's schema
 * and the alias itself does not, so this can never shadow a flag a tool really
 * has — `--image` on a tool that genuinely takes `image` is untouched.
 */
const FLAG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  screenshot: ['image', 'visual', 'picture', 'shot', 'see'],
  /*
   * `chart --chart-type=line` — REAL, four times in one session: the 4B wrote
   * the type as `--chart-type`, the flag passed through as an unknown key, and
   * the tool drew its default bar chart every time (and said so, which the
   * model did not read). `--kind` is the other spelling a model reaches for.
   */
  type: ['chart-type', 'chart_type', 'charttype', 'chart-kind', 'kind'],
  /*
   * `diagram --mermaid "flowchart TD …"`: the diagram's text is `--source`,
   * and a model that knows the text is Mermaid names the flag after it. Only
   * where the tool has `source` and no property of the alias's own name.
   */
  source: ['mermaid', 'mmd', 'definition', 'diagram'],
};

/** Resolve one flag name onto a schema property, or return it unchanged. */
export function resolveFlagName(key: string, props: Readonly<Record<string, unknown>>): string {
  if (key in props) return key;
  /* `--save-to` for a `save_to` property: the kebab spelling is the one a
     command line teaches, and a model that writes it is not wrong. Only when
     the snake spelling is really a property, so nothing is invented. */
  const snake = key.replace(/-/g, '_');
  if (snake !== key && snake in props) return snake;
  for (const [real, synonyms] of Object.entries(FLAG_ALIASES)) {
    if (real in props && synonyms.includes(key)) return real;
  }
  return key;
}

export function coerceArgs(
  raw: Readonly<Record<string, string | boolean>>,
  schema: CliSchema | undefined,
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = resolveFlagName(rawKey, props);
    const prop = props[key] as Record<string, unknown> | undefined;
    const type = typeof prop?.type === 'string' ? (prop.type as string) : unionType(prop);
    if (typeof value === 'boolean' || type === undefined) {
      out[key] = value;
      continue;
    }
    if (type === 'number' || type === 'integer') {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : value;
    } else if (type === 'boolean') {
      out[key] = value === 'true' || value === '1' || value === 'yes';
    } else if (type === 'array' || type === 'object') {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /*
         * The comma fallback is for a list of SCALARS — `--tags a,b,c` is a
         * shape a model reaches for and a shape that means something. Splitting
         * anything else invents data: an array of objects becomes ['{"a":1',
         * '"b":2}'], which the tool then rejects for a reason that has nothing
         * to do with what the model typed. Hand the raw string over instead and
         * let the tool's own validation say what it wanted.
         */
        out[key] = type === 'array' && scalarItems(prop) ? splitList(value) : value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The type of a union that is really one type — `anyOf: [{const:'up'}, …]` is
 * how a typebox union of literals arrives, and every branch of it is a string.
 *
 * Without this a union property has no type at all, so a numeric flag reaches
 * the tool as the string "3" and is rejected by its own validator. MEASURED on
 * `mac_scroll --amount`, whose amount is a union.
 */
function unionType(prop: Record<string, unknown> | undefined): string | undefined {
  const branches = (prop?.anyOf ?? prop?.oneOf) as unknown;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const types = new Set<string>();
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') return undefined;
    const b = branch as Record<string, unknown>;
    // `integer` is a `number` for the purpose of reading a flag: a union of the
    // two is still "this takes a number", and treating it as ambiguous is how
    // `--amount 40` reached a tool as the string "40".
    const t = typeof b.type === 'string' ? b.type : 'const' in b ? typeof b.const : undefined;
    if (t === undefined) return undefined;
    types.add(t === 'integer' ? 'number' : t);
  }
  return types.size === 1 ? [...types][0] : undefined;
}

/** Whether an array's items are scalars, so a comma-separated list means something. */
function scalarItems(prop: Record<string, unknown> | undefined): boolean {
  const items = prop?.items as Record<string, unknown> | undefined;
  if (items === undefined) return true;
  const t = typeof items.type === 'string' ? items.type : unionType(items);
  return t !== 'object' && t !== 'array';
}

/** Split `a,b,c`, honouring quotes so a value containing a comma survives. */
function splitList(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [])
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part !== '');
}

/** The schema properties a positional may fill, in declaration order. */
function positionalKeys(schema: CliSchema | undefined, count = 1): string[] {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props);
  const req = keys.filter((k) => required.has(k));
  if (req.length > 0) return req;

  /*
   * `mac click 660 558` — TWO numbers mean a POINT.
   *
   * MEASURED on a 27B driving Blender, which has no Accessibility tree to aim
   * at, so every act is a coordinate: it wrote the natural form and got "provide
   * an element index, or x and y" back. With nothing required, the first
   * property was the only positional slot, so both numbers were joined into
   * `index` as the string "660 558" — which is not a number, so the tool
   * rejected the very form it had just asked for.
   *
   * These tools take a target as EITHER an index OR a point, which a JSON schema
   * cannot say. The count does: one value is the index, two values are the pair.
   */
  if (count === 2 && isNumeric(props.x) && isNumeric(props.y)) return ['x', 'y'];
  return keys.slice(0, 1);
}

/** Does this property want a number? */
function isNumeric(prop: unknown): boolean {
  const p = prop as Record<string, unknown> | undefined;
  const t = typeof p?.type === 'string' ? p.type : unionType(p);
  return t === 'number' || t === 'integer';
}

// ── resolution ───────────────────────────────────────────────────────────────

export type CliResolution =
  | { kind: 'text'; text: string }
  | {
      kind: 'call';
      tool: string;
      args: Record<string, unknown>;
      /** Flags given that are not arguments of this command (see resolveCli). */
      unread?: readonly string[];
    }
  | { kind: 'error'; text: string };

/**
 * Resolve one command line against the surface.
 *
 * Every failure path here returns something the model can ACT on — the nearest
 * matching commands, or the exact help for what it half-typed. A bare "unknown
 * command" is what makes a model give up and claim it lacks the tool, which is
 * the failure this experiment is trying to eliminate rather than reproduce in a
 * new syntax.
 */
export function resolveCli(cli: CliModel, argv: readonly string[]): CliResolution {
  const parsed = parseArgv(argv);
  const [head, ...restWords] = parsed.words;

  if (head === undefined || head === 'tools') {
    if (restWords[0] === 'search') {
      const q = [...restWords.slice(1), ...parsed.positionals].join(' ').trim();
      return { kind: 'text', text: renderSearch(cli, q) };
    }
    return { kind: 'text', text: renderRootHelp(cli) };
  }

  const group = cli.groups.find((g) => g.name === head);
  if (group === undefined) {
    const near = searchCommands(cli, head).slice(0, 5);
    const lines = [
      `${head}: no such command.`,
      '',
      near.length > 0 ? 'Did you mean:' : 'Available commands:',
      ...(near.length > 0
        ? near.map((c) => `  ${commandLine(c)}`)
        : cli.groups.map((g) => `  ${g.name} — ${g.summary}`)),
      '',
      'Run `tools` for everything, or `tools search <words>` to look one up.',
    ];
    return { kind: 'error', text: lines.join('\n') };
  }

  /*
   * A GROUP WHOSE ONE COMMAND HAS NO SUB-WORD IS THAT COMMAND.
   *
   * `svg --image ref.png` has no words after the group, which used to mean
   * "show me the group" — right for `media`, where the next word picks among
   * five things, and wrong for a group that only has one thing and names it
   * by the group itself. With flags present the model is clearly calling, not
   * asking; a bare `svg` on its own still gets the help.
   */
  if (restWords.length === 0) {
    /*
     * The ROOT command — the one whose path is the group name alone (`svg`,
     * `chart`) — is what a line with flags and no sub-word is calling, whether
     * or not the group has other commands beside it (`chart edit`): `chart
     * --title … --values …` is a chart, not a request for the group page.
     */
    const rootCmd = group.commands.find((c) => c.path.length === 0);
    const hasFlags = Object.keys(parsed.flags).length > 0 || parsed.positionals.length > 0;
    /*
     * AND ITS `--help` IS THE COMMAND'S HELP. `svg --help` used to print the
     * group page — one line naming `svg` and "run `svg <command> --help` for
     * arguments" — for a command that HAS no sub-word to put there. MEASURED
     * by the tool surface probe: the one command whose help could not be
     * reached was the one the preamble tells the model to read first. With
     * siblings, they are named under it.
     */
    if (rootCmd !== undefined && parsed.wantsHelp) {
      const siblings = group.commands.filter((c) => c.path.length > 0);
      return {
        kind: 'text',
        text:
          siblings.length > 0
            ? `${renderCommandHelp(rootCmd)}\n\nAlso in this group: ${siblings.map((c) => `${commandLine(c)} (run it with --help)`).join(', ')}`
            : renderCommandHelp(rootCmd),
      };
    }
    if (rootCmd === undefined || !hasFlags) {
      return { kind: 'text', text: renderGroupHelp(group) };
    }
  }

  // Longest path wins, so `media generate image` beats a hypothetical
  // `media generate` without either having to be declared unambiguous.
  const match = [...group.commands]
    .filter((c) => c.path.every((w, i) => restWords[i] === w))
    .sort((a, b) => b.path.length - a.path.length)[0];

  if (match === undefined) {
    return {
      kind: 'error',
      text: [`${head} ${restWords.join(' ')}: no such command.`, '', renderGroupHelp(group)].join(
        '\n',
      ),
    };
  }

  if (parsed.wantsHelp) return { kind: 'text', text: renderCommandHelp(match) };

  const schema = schemaOf(match.tool);
  const leftover = restWords.slice(match.path.length);
  /*
   * A SWITCH TAKES NO VALUE. MEASURED (4B, the maths suite's lever): `svg
   * --figure "<svg …>"` — a switch, then what the model meant as the
   * command's text. The parser gave the markup to the switch, coercion made
   * it `figure: false`, and svg answered "give a prompt" with the prompt
   * gone. A boolean flag followed by a word that is not a yes or a no is the
   * switch, on, and the word goes where a positional goes.
   */
  const flags: Record<string, string | boolean> = { ...parsed.flags };
  const strayed: string[] = [];
  const props = schema?.properties ?? {};
  for (const [rawKey, value] of Object.entries(parsed.flags)) {
    const prop = props[resolveFlagName(rawKey, props)] as Record<string, unknown> | undefined;
    if (
      prop?.type === 'boolean' &&
      typeof value === 'string' &&
      !/^(true|false|yes|no|on|off|1|0)$/i.test(value.trim())
    ) {
      flags[rawKey] = true;
      strayed.push(value);
    }
  }
  const args = coerceArgs(flags, schema);

  /*
   * `mac click x:500 y:400` AND `mac click menu:"File > New Tab"`.
   *
   * MEASURED on a 4B driving Chrome: given a command it had not used before, it
   * invented `x:500 y:400` and `menu:"File > New Tab"` — both naming real
   * arguments of the command it had just read the help for, in a shape the
   * parser did not know. The keys are RIGHT; only the punctuation is wrong, and
   * refusing that measures our parser rather than the model, which is the same
   * reason the positional form is accepted at all.
   *
   * Gated on the key actually being an argument of THIS command, so a URL
   * (`https://…`), a Windows path or any other colon in a value stays a value.
   */
  const keyed: Record<string, string> = {};
  const bare: string[] = [];
  for (const word of [...leftover, ...strayed, ...parsed.positionals]) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(word);
    const key = m?.[1];
    const value = m?.[2];
    if (key !== undefined && value !== undefined && value !== '' && props[key] !== undefined) {
      keyed[key] = value;
    } else {
      bare.push(word);
    }
  }
  Object.assign(args, coerceArgs(keyed, schema));

  /* Positionals fill required arguments in order — `media generate image "a red
     fox"` is the line a person (or a small model) actually writes, and refusing
     it would measure our parser rather than the model. Flags always win.

     They go through coerceArgs for the same reason the flags do: `click 1` and
     `click --index 1` are the same line typed two ways, so a positional that
     stayed a raw string would be rejected by the tool's own `typeof !== number`
     guard — on the very form the help advertises as
     `click "index"  (positional: fills --index)`. */
  /*
   * `[2]` IS AN INDEX — because that is how the snapshot prints it.
   *
   * MEASURED, MiniCPM5 driving Maps: the element list says `[2] Apple Maps`, so
   * the model wrote `mac type [2] "Table Mountain"` — the notation it had just
   * been shown. The CLI did not recognise it, dropped it, and the tool refused
   * with "refusing to type without an index", which the model read as plainly
   * wrong: it HAD passed [2]. It burned four calls arguing with that before
   * running `mac type --help` and rewriting the same line as
   * `--text "…" --index 2`.
   *
   * Teaching one notation in the output and accepting only another in the input
   * is the harness's mistake, not the model's. A bracketed number fills `index`
   * wherever the tool has one, and never competes for an ordinary positional
   * slot.
   */
  let spare = bare;
  if (schema?.properties?.index !== undefined && args.index === undefined) {
    const bracketed = spare.find((a) => /^\[\d+\]$/.test(a));
    if (bracketed !== undefined) {
      args.index = Number(bracketed.slice(1, -1));
      spare = spare.filter((a) => a !== bracketed);
    }
  }
  /*
   * A FILE NAME AMONG THE POSITIONALS IS THE OUTPUT. MEASURED on a 4B:
   * `svg "--prompt=a bicycle…" bicycle.svg` — the name it gave was joined
   * into the prompt slot, the drawing landed in Generated under the tool's
   * own name, and two `cp` calls (the first to a folder that did not exist)
   * moved it where the model had asked for it in the first place. A word
   * ending in an extension is a path, never a prompt: where the tool has an
   * `out` and something else fills the prompt, the path fills `out`.
   */
  if (props.out !== undefined && args.out === undefined) {
    const looksLikePath = (a: string) => /^[^\s"']+\.[A-Za-z0-9]{2,5}$/.test(a);
    const at = spare.findIndex(looksLikePath);
    const firstKey = positionalKeys(schema, 1)[0];
    const promptFilled =
      firstKey !== undefined && firstKey !== 'out' && args[firstKey] !== undefined;
    if (at >= 0 && (promptFilled || spare.length > 1)) {
      args.out = spare[at];
      spare = spare.filter((_a, i) => i !== at);
    }
  }
  if (spare.length > 0) {
    const keys = positionalKeys(schema, spare.length).filter((k) => args[k] === undefined);
    const raw: Record<string, string> = {};
    keys.forEach((key, i) => {
      const v = i === keys.length - 1 ? spare.slice(i).join(' ') : spare[i];
      if (v !== undefined && v !== '') raw[key] = v;
    });
    Object.assign(args, coerceArgs(raw, schema));
  }

  // A required property a tool marks `cliOptional` is one it can work out
  // for itself (office_make reads the kind from the brief or the out path);
  // the CLI leaves it to the tool rather than refusing at the door.
  const missing = (schema?.required ?? []).filter(
    (k) =>
      args[k] === undefined &&
      (props[k] as { cliOptional?: unknown } | undefined)?.cliOptional !== true,
  );
  if (missing.length > 0) {
    return {
      kind: 'error',
      text: [
        `${commandLine(match)}: missing ${missing.map((m) => `--${m}`).join(', ')}.`,
        '',
        renderCommandHelp(match),
      ].join('\n'),
    };
  }

  /*
   * A FLAG THE COMMAND DOES NOT HAVE IS SAID, NOT SWALLOWED. MEASURED (4B, the
   * visual suite's icon set): `svg recipe-app-icons --icons timer,servings,…`
   * — the six icons it was asked for went into a flag `svg` does not have. The
   * flag passed through as an unknown key (coerceArgs), the tool read its own
   * arguments and nothing else, and the answer was one drawing "— 3 paths",
   * with no word that the list had gone nowhere. It ran the same line twice
   * more. A tool's schema is its contract, so a key outside it was not read;
   * the call still runs, and the result says which flags did nothing and what
   * the command takes. A schema that declares it takes more is left alone.
   */
  const unread =
    Object.keys(props).length > 0 && schema?.additionalProperties !== true
      ? Object.keys(args).filter((k) => !(k in props))
      : [];
  return unread.length > 0
    ? { kind: 'call', tool: match.tool.name, args, unread }
    : { kind: 'call', tool: match.tool.name, args };
}

/** The line a result gets when some of its flags were not the command's. */
export function unreadFlagsNote(cli: CliModel, tool: string, unread: readonly string[]): string {
  let cmd: CliCommand | undefined;
  for (const g of cli.groups) cmd ??= g.commands.find((c) => c.tool.name === tool);
  if (cmd === undefined || unread.length === 0) return '';
  const takes = Object.keys(schemaOf(cmd.tool)?.properties ?? {}).map((k) => `--${k}`);
  const flags = unread.map((k) => `--${k}`).join(', ');
  const [verb, it] =
    unread.length === 1 ? ['is not an argument', 'it'] : ['are not arguments', 'they'];
  return (
    `\n\nNote: ${flags} ${verb} of \`${commandLine(cmd)}\`, so ${it} did nothing. ` +
    `It takes ${takes.join(', ')} — \`${commandLine(cmd)} --help\` says what each does.`
  );
}

// ── a call named like a command ──────────────────────────────────────────────

/**
 * THE COMMAND LINE FOR A TOOL CALL THAT NAMED THE COMMAND.
 *
 * MEASURED 2026-09-15 (qwen3.5-4b, rapid-mlx, bash-CLI mode): asked for a
 * picture, the model emitted a STRUCTURED call named `media generate image`
 * with `{prompt, save_to}` as its arguments — the command it had been told
 * about, as a tool name, with the command's own flags. Then `media --help` the
 * same way, then `coordinate present` with a `file_path`. pi answers "Tool …
 * not found" to each, and the model painted the cow with PIL.
 *
 * Every one of those is the line the shell would have run, written in the
 * other notation. The translation is mechanical — the words are the command
 * path, the arguments are its flags — so this turns the call back into the
 * line, and the provider hands it to `bash` (resolveUnknownToolName). Nothing
 * is invented: the head word has to be one of OUR shims, so `ls`, `python3` or
 * a hallucinated name still fall through to "not found".
 *
 * Arguments the command's schema knows become `--key=value` (the form
 * `parseArgv` reads without consuming the next word); ones it does not know
 * become positionals, so `present {file_path}` still fills `--path` the way a
 * typed `coordinate present <file>` does. A tool's registered name is accepted
 * too (`web_search`, `present`): a model that reaches for the schemas-mode
 * name it learned is naming the same thing.
 */
export function commandLineForCall(
  cli: CliModel,
  name: string,
  args: Readonly<Record<string, unknown>>,
  shimCommands: readonly string[],
): string | undefined {
  const words = commandWordsFor(cli, name, shimCommands);
  if (words === undefined) return undefined;
  const command = findCommand(cli, words);
  const props = command === undefined ? undefined : schemaOf(command.tool)?.properties;
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (props !== undefined && !(resolveFlagName(key, props) in props)) {
      positionals.push(text);
      continue;
    }
    flags.push(`--${key}=${text}`);
  }
  return [...words, ...flags, ...positionals].map(shellWord).join(' ');
}

/** The command path a call's name stands for, or undefined when it is not ours. */
function commandWordsFor(
  cli: CliModel,
  name: string,
  shimCommands: readonly string[],
): string[] | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  for (const g of cli.groups) {
    for (const c of g.commands) {
      if (c.tool.name === trimmed) return [g.name, ...c.path];
    }
  }
  /* Spaces, or the joiners a model writes instead of them: `media_generate_image`,
     `media.generate.image`, `media:generate`. Only the single-token form is
     split that way — a real flag such as `--save-to` keeps its hyphen. */
  let words = trimmed.split(/\s+/).filter((w) => w !== '');
  if (words.length === 1) words = trimmed.split(/[_.:/]+/).filter((w) => w !== '');
  const head = words[0];
  if (head === undefined) return undefined;
  return head === 'tools' || shimCommands.includes(head) ? words : undefined;
}

/** The command the leading words name — longest path wins, as in resolveCli. */
function findCommand(cli: CliModel, words: readonly string[]): CliCommand | undefined {
  const [head, ...rest] = words;
  const group = cli.groups.find((g) => g.name === head);
  if (group === undefined) return undefined;
  return [...group.commands]
    .filter((c) => c.path.every((w, i) => rest[i] === w))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * One argv word, safe for /bin/sh. Double quotes rather than single so a `$`
 * arrives escaped: the bash tool's `protectShimDollars` leaves an escaped one
 * alone, and inside single quotes its backslash would have reached the tool.
 */
function shellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `"${word.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

function schemaOf(tool: CliTool): CliSchema | undefined {
  const p = tool.parameters;
  return typeof p === 'object' && p !== null ? (p as CliSchema) : undefined;
}

/** `media generate image` */
export function commandLine(c: CliCommand): string {
  return [c.group, ...c.path].join(' ');
}

// ── help + search ────────────────────────────────────────────────────────────

export function renderRootHelp(cli: CliModel): string {
  const lines = [
    'Tools available in this shell. Every one is a normal command — run it with',
    '--help to see its arguments.',
    '',
  ];
  for (const g of cli.groups) {
    lines.push(`  ${g.name.padEnd(10)} ${g.summary}`);
  }
  lines.push(
    '',
    'Examples:',
    '  media --help                     what the media command can do',
    '  media generate image "a red fox" make a picture',
    '  tools search voice               find a command by what it does',
  );
  return lines.join('\n');
}

export function renderGroupHelp(group: {
  name: string;
  summary: string;
  commands: readonly CliCommand[];
}): string {
  const lines = [`${group.name} — ${group.summary}`, '', 'Commands:'];
  for (const c of group.commands) {
    const first = (c.tool.description ?? '').split(/(?<=\.)\s/)[0] ?? '';
    lines.push(`  ${commandLine(c).padEnd(28)} ${first}`);
  }
  lines.push('', `Run \`${group.name} <command> --help\` for arguments.`);
  return lines.join('\n');
}

export function renderCommandHelp(c: CliCommand): string {
  const schema = schemaOf(c.tool);
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props);
  const pos = positionalKeys(schema);

  const usage = [
    'Usage:',
    `  ${commandLine(c)} ${keys.length > 0 ? '[--key value …]' : ''}`.trimEnd(),
  ];
  if (pos.length > 0) {
    usage.push(`  ${commandLine(c)} "${pos[0]}"   (positional: fills --${pos[0]})`);
  }
  const lines = [...usage, ''];
  if (c.tool.description !== undefined && c.tool.description !== '') {
    lines.push(c.tool.description, '');
  }
  if (keys.length === 0) {
    lines.push('Arguments: none.');
    return lines.join('\n');
  }
  lines.push('Arguments:');
  for (const key of keys) {
    const p = props[key] ?? {};
    const type = typeof p.type === 'string' ? p.type : 'string';
    const req = required.has(key) ? ' (required)' : '';
    const desc = typeof p.description === 'string' ? ` — ${p.description}` : '';
    const enumVals = Array.isArray(p.enum) ? ` [${p.enum.join('|')}]` : '';
    lines.push(`  --${key} <${describeType(p, type)}>${enumVals}${req}${desc}`);
    lines.push(...shapeLines(p));
  }
  return lines.join('\n');
}

/** `array of string`, `array of object`, or the plain type. */
function describeType(p: Record<string, unknown>, type: string): string {
  // The ALLOWED VALUES, when there is a closed set of them. A schema hands the
  // model `enum: ["up","down"]`; help that says only `<string>` reaches the
  // same parameter and loses the one thing that makes it usable. A typebox
  // union of literals arrives as `anyOf: [{const:"up"}, …]`, which has no enum
  // line at all — measured on `mac_scroll --direction`, whose four values were
  // documented nowhere.
  const choices = literalChoices(p);
  if (choices !== undefined) return choices.join('|');
  if (type !== 'array') return type;
  const items = p.items as Record<string, unknown> | undefined;
  const innerChoices = literalChoices(items);
  if (innerChoices !== undefined) return `array of ${innerChoices.join('|')}`;
  const inner = typeof items?.type === 'string' ? items.type : undefined;
  return inner === undefined ? 'array' : `array of ${inner}`;
}

/** The closed set a property accepts, from `enum` or a union of literals. */
function literalChoices(p: Record<string, unknown> | undefined): string[] | undefined {
  if (p === undefined) return undefined;
  if (Array.isArray(p.enum) && p.enum.length > 0) return p.enum.map((v) => String(v));
  const branches = (p.anyOf ?? p.oneOf) as unknown;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const out: string[] = [];
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') return undefined;
    const b = branch as Record<string, unknown>;
    if (!('const' in b)) return undefined;
    out.push(String(b.const));
  }
  return out;
}

/**
 * THE SHAPE OF A NESTED ARGUMENT, or the model has to guess its key names.
 *
 * An MCP client hands the model the entire JSON Schema, so it can see that
 * `--assignee` takes `{login, notify}`. Help that says only `--assignee
 * <object>` reaches the same argument and loses the same information — every
 * field is technically passable and none of them is knowable. That is the one
 * real capability gap between a tool called as a schema and the same tool
 * called as a command, and it costs nothing to close: this text is read on
 * demand by `--help`, not carried in the system prompt.
 *
 * One level deep, because a schema nested deeper than that is better read as
 * JSON than as an outline, and the JSON is what the flag takes anyway. Pure.
 */
function shapeLines(p: Record<string, unknown>): string[] {
  const type = typeof p.type === 'string' ? p.type : '';
  const shape = (type === 'array' ? (p.items as Record<string, unknown> | undefined) : p) as
    | CliSchema
    | undefined;
  if (shape === undefined || typeof shape !== 'object') return [];
  const props = shape.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return [];
  const required = new Set(shape.required ?? []);
  const noun = type === 'array' ? 'each entry' : 'JSON object';
  return [
    `      ${noun}: {${keys.join(', ')}}`,
    ...keys.map((k) => {
      const q = props[k] ?? {};
      const t = typeof q.type === 'string' ? q.type : 'string';
      const d = typeof q.description === 'string' ? ` — ${q.description}` : '';
      return `        ${k} <${t}>${required.has(k) ? ' (required)' : ''}${d}`;
    }),
  ];
}

/**
 * Keyword search over command names and descriptions.
 *
 * Not semantic, on purpose: a local embedding pass per lookup is a real cost on
 * the machine that is also running the model, and the thing being searched is a
 * few dozen short strings. Every word of the query must appear somewhere in the
 * command, which is what makes "make a sound" find `media generate sfx`.
 */
export function searchCommands(cli: CliModel, query: string): CliCommand[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  const scored: { c: CliCommand; score: number }[] = [];
  for (const g of cli.groups) {
    for (const c of g.commands) {
      const hay = `${commandLine(c)} ${c.tool.name} ${c.tool.description ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (commandLine(c).toLowerCase().includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ c, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

export function renderSearch(cli: CliModel, query: string): string {
  if (query === '') return 'Usage: tools search <words>';
  const hits = searchCommands(cli, query);
  if (hits.length === 0) {
    return [`Nothing matches "${query}".`, '', renderRootHelp(cli)].join('\n');
  }
  const lines = [`Commands matching "${query}":`, ''];
  for (const c of hits.slice(0, 12)) {
    const first = (c.tool.description ?? '').split(/(?<=\.)\s/)[0] ?? '';
    lines.push(`  ${commandLine(c).padEnd(28)} ${first}`);
  }
  lines.push('', 'Run any of them with --help for arguments.');
  return lines.join('\n');
}
