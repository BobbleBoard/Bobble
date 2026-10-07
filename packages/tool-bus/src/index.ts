/**
 * One place in the pi process to find a tool's `execute`.
 *
 * THE PROBLEM IT SOLVES. pi hands every extension its own `ExtensionAPI`, and
 * `getAllTools()` returns `ToolInfo` —
 * `Pick<ToolDefinition, 'name' | 'description' | 'parameters'>`, with no
 * `execute`. So an extension can SEE every tool in the process and run none but
 * its own. That is invisible until something wants to dispatch across the
 * boundary, and then it is severe: the bash-CLI interface builds one command
 * surface for the whole app and could only execute the harness's own tools.
 * `browser click`, `mac snapshot`, `media generate image` and every connector
 * command were listed by `tools`, documented by `--help`, and answered "not
 * registered in this build" when run — the false-availability failure that
 * interface exists to remove, reproduced one layer down. MEASURED on the shipped
 * build: pi knew 56 tools, 14 of them were runnable.
 *
 * WHY THE MAP HANGS OFF `globalThis`. Every extension is loaded with `-e` into
 * the SAME pi child process, but not into the same module graph — pi loads each
 * extension entry separately, so a plain module-level `Map` gives every
 * extension its own. Measured: the harness saw an empty bus while browser-use,
 * mac-connectors and gen-tools had all published into theirs. A `Symbol.for` key
 * on the process object is the one thing they genuinely share. Nothing crosses a
 * process boundary; if that ever changes this becomes a socket and the callers
 * do not move.
 *
 * WHAT IT IS NOT. Not a permission system and not an advertisement. Publishing
 * here does not put a tool in front of the model — `setActiveTools` still
 * decides that. It only means: if something in this process legitimately holds a
 * tool's name, it can now run it instead of reporting it missing.
 */

/**
 * What the bus needs from a tool — structural on purpose.
 *
 * Not pi's `ToolDefinition`: that is generic over its schema and requires fields
 * the bus has no use for, so typing against it would make every caller's tool a
 * type-compatibility problem rather than a lookup.
 */
export interface SharedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly execute: (id: unknown, params: unknown, ...rest: unknown[]) => Promise<unknown>;
}

/**
 * What a CALLER passes in — deliberately looser than {@link SharedTool}.
 *
 * Each tool declares its own precisely-typed `params`, and requiring them to
 * accept `unknown` would reject every real call site. Callers keep their types;
 * the bus stores the erased view, because a cross-extension lookup cannot know
 * the schema anyway.
 */
export interface RegisterableTool {
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: the caller's own signature wins.
  readonly execute: (...args: any[]) => any;
}

/** Anything with a `registerTool` — pi's ExtensionAPI, structurally. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors pi's own registerTool signature.
type RegistrarLike = { registerTool: (def: any) => unknown };

const BUS_KEY = Symbol.for('@pi-desktop/tool-bus');
type BusHost = { [BUS_KEY]?: Map<string, SharedTool> };

function busMap(): Map<string, SharedTool> {
  const host = globalThis as unknown as BusHost;
  const existing = host[BUS_KEY];
  if (existing !== undefined) return existing;
  const created = new Map<string, SharedTool>();
  host[BUS_KEY] = created;
  return created;
}

/**
 * Register a tool with pi AND publish its executor on the bus.
 *
 * A drop-in for `pi.registerTool(tool)` — same argument, same effect, plus the
 * tool becomes runnable from elsewhere in the process. Returns the tool so it
 * can still be used in an expression.
 *
 * Publishes FIRST, so a throw from the real registrar cannot leave a tool that
 * something can be told about but nothing can run.
 */
export function shareTool<T extends RegisterableTool>(pi: RegistrarLike, tool: T): T {
  busMap().set(tool.name, tool as unknown as SharedTool);
  pi.registerTool(tool);
  return tool;
}

/** Publish an already-registered tool. Prefer {@link shareTool}. */
export function publishTool(tool: RegisterableTool): void {
  busMap().set(tool.name, tool as unknown as SharedTool);
}

/** The tool by that name, or undefined when nothing in this process shared it. */
export function sharedTool(name: string): SharedTool | undefined {
  return busMap().get(name);
}

/** Every shared tool name, in publication order. */
export function sharedToolNames(): string[] {
  return [...busMap().keys()];
}

/** Test seam. Never call this from a real extension. */
export function resetToolBus(): void {
  busMap().clear();
  delete (globalThis as unknown as { [k: symbol]: unknown })[
    Symbol.for('@pi-desktop/tool-bus/connectors')
  ];
}

/**
 * THE CONNECTORS THE PERSON ADDED, for the prompt that names them.
 *
 * MEASURED (Qwen 3.5 4B, 2026-10-06, connector-call-probe): with the Time
 * connector added and working — `pi-tool list` answered with its two tools —
 * the system prompt said nothing of it, and asked the time in Tokyo the model
 * ran `date` and tried curl. A connector the model is never told about is not
 * there. mcp-lite (which reads the registry) publishes the list here; the
 * harness (which writes the abilities list) reads it. Same process, separate
 * module graphs — the reason this sits on the bus.
 */
export interface SharedConnector {
  /** The registry id: the word after `pi-tool`. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

const CONNECTORS_KEY = Symbol.for('@pi-desktop/tool-bus/connectors');
type ConnectorHost = { [CONNECTORS_KEY]?: readonly SharedConnector[] };

/** Replace the published list (mcp-lite, once it has read the registry). */
export function publishConnectors(list: readonly SharedConnector[]): void {
  (globalThis as unknown as ConnectorHost)[CONNECTORS_KEY] = [...list];
}

/** The published connectors, in registry order; empty when none were published. */
export function sharedConnectors(): readonly SharedConnector[] {
  return (globalThis as unknown as ConnectorHost)[CONNECTORS_KEY] ?? [];
}
