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
  create_scheduled_task: ['schedule'],
  update_plan: ['plan'],
  spawn_subagent: ['delegate'],
  talk_to_manager: ['manager'],
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
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const words: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let wantsHelp = false;
  let seenFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
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
export function coerceArgs(
  raw: Readonly<Record<string, string | boolean>>,
  schema: CliSchema | undefined,
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const type = typeof props[key]?.type === 'string' ? (props[key]?.type as string) : undefined;
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
        out[key] = type === 'array' ? value.split(',').map((s) => s.trim()) : value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The schema properties a positional may fill, in declaration order. */
function positionalKeys(schema: CliSchema | undefined): string[] {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props);
  const req = keys.filter((k) => required.has(k));
  return req.length > 0 ? req : keys.slice(0, 1);
}

// ── resolution ───────────────────────────────────────────────────────────────

export type CliResolution =
  | { kind: 'text'; text: string }
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
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

  if (restWords.length === 0) {
    return { kind: 'text', text: renderGroupHelp(group) };
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
  const args = coerceArgs(parsed.flags, schema);

  /* Positionals fill required arguments in order — `media generate image "a red
     fox"` is the line a person (or a small model) actually writes, and refusing
     it would measure our parser rather than the model. Flags always win. */
  const spare = [...leftover, ...parsed.positionals];
  if (spare.length > 0) {
    const keys = positionalKeys(schema).filter((k) => args[k] === undefined);
    keys.forEach((key, i) => {
      const v = i === keys.length - 1 ? spare.slice(i).join(' ') : spare[i];
      if (v !== undefined && v !== '') args[key] = v;
    });
  }

  const missing = (schema?.required ?? []).filter((k) => args[k] === undefined);
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

  return { kind: 'call', tool: match.tool.name, args };
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
  if (type !== 'array') return type;
  const items = p.items as Record<string, unknown> | undefined;
  const inner = typeof items?.type === 'string' ? items.type : undefined;
  return inner === undefined ? 'array' : `array of ${inner}`;
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
