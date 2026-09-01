/**
 * THE CODING HARNESSES BOBBLE CAN DRIVE, AND HOW EACH ONE ATTACHES.
 *
 * the user: "add that harness swapping mechanism in full working easily, and add to
 * onboarding, we want codex, claude code, hermes, pi, opencode, or other I
 * guess? ideally easily support for other dropping in any custom pi config
 * somehow. system pi detected and put in also."
 *
 * THE THING THAT MAKES THIS NOT A DROPDOWN OVER ONE LIST: these are two
 * different kinds of software wearing the same word.
 *
 *   EMBEDDED  pi, spoken over `pi --mode rpc`. The app IS the client: it drives
 *             the turn loop, owns the tools, and renders the stream. Swapping
 *             here means pointing at a different pi BINARY or config — the
 *             bundled one, one already on the user's PATH, or a custom config.
 *
 *   EXTERNAL  Claude Code, Codex, OpenCode, Hermes. Each is its own client with
 *             its own protocol, prompt format and tool contract. Bobble cannot
 *             render their turns, and pretending otherwise is how you ship a
 *             harness picker where four of the five options quietly do nothing.
 *             What Bobble CAN do — and what actually makes them useful offline —
 *             is serve the local model on an OpenAI-compatible endpoint and hand
 *             the user the exact command that points the agent at it.
 *
 * So `attach` is the honest distinction, and the panel renders the two groups
 * differently rather than flattening them into one list of equals.
 */

export type HarnessAttach = 'embedded' | 'external';

export interface HarnessSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly attach: HarnessAttach;
  /**
   * Executable to look for on PATH to decide "installed". Absent for the
   * bundled harness, which ships inside the app and is always present.
   */
  readonly bin?: string;
  /**
   * Environment variables that point an external agent at a local
   * OpenAI-compatible server. Rendered into copyable setup instructions.
   */
  readonly env?: (baseUrl: string, model: string) => Record<string, string>;
  /** Command the user runs after setting the env, if the agent needs one. */
  readonly launch?: string;
  /** Where to read more, when the agent needs its own setup step. */
  readonly docs?: string;
}

/** OpenAI-compatible agents differ only in which env var names they read. */
const openaiEnv =
  (base: string, key: string, model?: string) =>
  (baseUrl: string, modelId: string): Record<string, string> => {
    const out: Record<string, string> = { [base]: `${baseUrl}`, [key]: 'local' };
    if (model !== undefined) out[model] = modelId;
    return out;
  };

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: 'pi-bundled',
    name: 'pi (bundled)',
    blurb: 'Ships with Bobble. Drives the chat, tools and subagents you see in the app.',
    attach: 'embedded',
  },
  {
    id: 'pi-system',
    name: 'pi (system)',
    blurb: 'A pi already installed on this machine. Use your own build or version.',
    attach: 'embedded',
    bin: 'pi',
  },
  {
    id: 'pi-custom',
    name: 'Custom pi config',
    blurb: 'Point pi at your own config file: presets, tools and prompts.',
    attach: 'embedded',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: "Anthropic's terminal agent, pointed at your local model instead of the API.",
    attach: 'external',
    bin: 'claude',
    env: openaiEnv('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'),
    launch: 'claude',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    blurb: "OpenAI's terminal agent. Needs an OpenAI-compatible server, which Bobble serves.",
    attach: 'external',
    bin: 'codex',
    env: openaiEnv('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'),
    launch: 'codex',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    blurb: 'Open-source terminal agent. Connects to any OpenAI-compatible endpoint.',
    attach: 'external',
    bin: 'opencode',
    env: openaiEnv('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'),
    launch: 'opencode',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    blurb: 'Nous Research’s agent. Same local endpoint, its own tool style.',
    attach: 'external',
    bin: 'hermes',
    env: openaiEnv('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'),
    launch: 'hermes',
  },
];

/** What the app knows about a harness on THIS machine. */
export interface HarnessState {
  readonly id: string;
  /** Found on PATH (external + system pi), or shipped with the app (bundled). */
  readonly installed: boolean;
  /** Absolute path we found, for the row to show. */
  readonly path?: string;
  /** Version string, when the binary reported one. */
  readonly version?: string;
}

/**
 * The harness Bobble uses for its OWN chat. Only an embedded one can be that,
 * because the app has to speak its protocol — an external agent is something
 * the user runs in their terminal against our server, not something that can
 * render inside our chat.
 */
export function canDriveChat(spec: HarnessSpec): boolean {
  return spec.attach === 'embedded';
}

/**
 * Selectable = we could actually switch to it right now. The bundled pi always
 * qualifies; anything else has to be present. A custom config is selectable only
 * once a path has been supplied, which is why it takes one.
 */
export function isSelectable(
  spec: HarnessSpec,
  state: HarnessState | undefined,
  customConfigPath?: string,
): boolean {
  if (spec.id === 'pi-bundled') return true;
  if (spec.id === 'pi-custom') return (customConfigPath ?? '').trim().length > 0;
  return state?.installed === true;
}

/**
 * The shell lines that point an external agent at Bobble's local server.
 * Returned as data rather than a formatted blob so the panel can render a
 * copy button per line and the tests can assert the pairs.
 */
export function connectCommands(
  spec: HarnessSpec,
  baseUrl: string,
  model: string,
): { exports: Array<{ name: string; value: string }>; launch: string | null } {
  if (spec.attach !== 'external' || spec.env === undefined) {
    return { exports: [], launch: null };
  }
  const env = spec.env(baseUrl, model);
  return {
    exports: Object.entries(env).map(([name, value]) => ({ name, value })),
    launch: spec.launch ?? null,
  };
}

/** One copy-pasteable block: every export, then the launch command. */
export function connectScript(spec: HarnessSpec, baseUrl: string, model: string): string {
  const { exports, launch } = connectCommands(spec, baseUrl, model);
  const lines = exports.map((e) => `export ${e.name}=${JSON.stringify(e.value)}`);
  if (launch !== null) lines.push(launch);
  return lines.join('\n');
}

/**
 * Embedded first (they can actually drive the chat), then external, each group
 * keeping catalog order. Within a group, installed ones come first so the user
 * sees what they can use today before what they'd have to install.
 */
export function orderHarnessesForDisplay(
  states: Record<string, HarnessState | undefined>,
  harnesses: readonly HarnessSpec[] = HARNESSES,
): HarnessSpec[] {
  const rank = (s: HarnessSpec): number => {
    const installed = s.id === 'pi-bundled' || states[s.id]?.installed === true;
    return (s.attach === 'embedded' ? 0 : 2) + (installed ? 0 : 1);
  };
  return [...harnesses].sort((a, b) => rank(a) - rank(b));
}
