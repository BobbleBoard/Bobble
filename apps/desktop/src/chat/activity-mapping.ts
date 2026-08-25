/**
 * Pure mapping from pi-slice message blocks → the design system's
 * `ActivityStepData` (THEME 3 chains). One assistant turn's consecutive
 * thinking + tool-call blocks become a collapsed ActivityChain; each block maps
 * to a step whose kind drives the icon, past/present-tense label, and inline
 * content (bash command+output / edit diff / file preview / web-search results).
 * Media/preview kinds (image/pdf) carry `opensInCanvas` + a `tabSpec` the app
 * routes to a canvas tab instead of expanding inline. No React here — unit-testable.
 */

import type { CanvasTabSpec } from '@pi-desktop/canvas';
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import type {
  ActivityStepData,
  ActivityStepKind,
  DiffFileData,
  DiffLine,
  WebSearchResultData,
} from '@pi-desktop/ui';
// Deep source import of the PURE connector-icons module (only pulls
// `simple-icons`), NOT the `@pi-desktop/mcp-lite` barrel — value-importing the
// barrel would drag the MCP/pi SDK into the renderer bundle and break `vite build`
// (the renderer-barrel gotcha). Same sanctioned deep-path seam
// `HarnessStatus.tsx`/`composer-bar-logic.ts` use for harness/src.
import { connectorIconSvg } from '../../../../packages/mcp-lite/src/connector-icons.ts';
import { type DetectedArtifact, segmentMessageText } from './canvas/artifacts';
import { pdFileUrl } from './canvas/file-preview';
import { CONTENT_KEYS, PATH_KEYS, partialJsonString } from './partial-json';

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;
type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>;
/** The blocks a chain is built from — thinking + tool calls, no visible text. */
export type ActivityBlock = Extract<ContentBlock, { type: 'thinking' | 'toolCall' }>;

/** Ordered render units for one assistant turn. */
export type ThreadSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thoughts'; blocks: ThinkingBlock[] }
  | { kind: 'chain'; blocks: ActivityBlock[] };

/**
 * Split assistant blocks into text / standalone-thought / chain segments.
 * GROUPING RULE: a maximal run of consecutive thinking + tool-call blocks with
 * NO text between them (and no user turn — turns are separate messages)
 * coalesces into one chain; a run with at least one tool call is a `chain`, a
 * run of only thoughts is standalone `thoughts`. Pure + unit-tested.
 */
export function segmentBlocks(blocks: ContentBlock[]): ThreadSegment[] {
  const segments: ThreadSegment[] = [];
  let buffer: ActivityBlock[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.some((b) => b.type === 'toolCall')) {
      segments.push({ kind: 'chain', blocks: buffer });
    } else {
      segments.push({ kind: 'thoughts', blocks: buffer as ThinkingBlock[] });
    }
    buffer = [];
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      flush();
      if (block.text.length > 0) segments.push({ kind: 'text', text: block.text });
    } else {
      buffer.push(block);
    }
  }
  flush();
  return segments;
}

/** A render unit for one assistant response GROUP: the {@link ThreadSegment}s
 * plus inline artifacts spliced in at their SOURCE position (A1). */
export type GroupSegment = ThreadSegment | { kind: 'artifact'; artifact: DetectedArtifact };

/**
 * Segment a whole assistant response group (coalesced messages) into ordered
 * render units, interleaving inline artifacts (```svg / ```html) exactly where
 * their fence appeared between the surrounding text — NOT bunched at the foot.
 *
 * Chains/thoughts still coalesce ACROSS message boundaries (a chain is a
 * maximal run of thinking + tool-call blocks with no text between, and pi
 * splits one response into several messages), so the fence counter is tracked
 * per message id to keep artifact ids aligned with `detectArtifacts`.
 */
export function segmentGroup(group: AssistantMsg[]): GroupSegment[] {
  const segments: GroupSegment[] = [];
  let buffer: ActivityBlock[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.some((b) => b.type === 'toolCall')) {
      segments.push({ kind: 'chain', blocks: buffer });
    } else {
      segments.push({ kind: 'thoughts', blocks: buffer as ThinkingBlock[] });
    }
    buffer = [];
  };

  const fenceCounts = new Map<string, number>();
  for (const message of group) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        flush();
        if (block.text.length === 0) continue;
        const start = fenceCounts.get(message.id) ?? 0;
        const { segments: parts, nextIndex } = segmentMessageText(
          block.text,
          message.id,
          message.isStreaming === true,
          start,
        );
        fenceCounts.set(message.id, nextIndex);
        for (const part of parts) {
          if (part.kind === 'markdown') segments.push({ kind: 'text', text: part.text });
          else segments.push({ kind: 'artifact', artifact: part.artifact });
        }
      } else {
        buffer.push(block);
      }
    }
  }
  flush();
  return segments;
}

/** A mapped step plus the optional canvas tab it opens (image/pdf/preview). */
export interface MappedStep {
  data: ActivityStepData;
  /** When set, this step's `opensInCanvas` is true; activating it opens this tab. */
  tabSpec?: CanvasTabSpec;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickPath(args: Record<string, unknown>): string | undefined {
  return (
    str(args.path) ??
    str(args.file_path) ??
    str(args.filename) ??
    str(args.file) ??
    str(args.target_file) ??
    str(args.url)
  );
}

function baseName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return path.split(/[/\\]/).pop() || path;
}

/**
 * True when a read targets a pi SKILL / tool-instructions file (Wave B #3a) —
 * so the chain renders it as "Read a skill" (own glyph), NOT a plain file read.
 *
 * A pi skill is a `SKILL.md` playbook auto-discovered under the agent skills
 * dir (`~/.pi/agent/skills/<name>/SKILL.md`) or the project dir
 * (`<cwd>/.pi/skills/<name>/SKILL.md`); a skill's supporting files live beside
 * it under that same `.pi/(agent/)skills/` tree. We detect BOTH the canonical
 * playbook (basename `SKILL.md`) and anything under a pi skills dir. Kept in
 * lock-step with the harness framing detector (skill-instructions.ts).
 */
export function isSkillPath(path: string | undefined): boolean {
  if (path === undefined || path.length === 0) return false;
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  if (base.toLowerCase() === 'skill.md') return true;
  return /(^|\/)\.pi\/(agent\/)?skills\//.test(norm);
}

/** Present-tense (running) / past-tense (done) label per step kind. Connector +
 * generic-tool rows override this with a name-derived label (see {@link labelFor}). */
const STEP_LABELS: Record<ActivityStepKind, [running: string, done: string]> = {
  thinking: ['Thinking…', 'Thought'],
  bash: ['Running a command', 'Ran a command'],
  python: ['Running Python', 'Ran Python'],
  edit: ['Editing a file', 'Edited a file'],
  read: ['Reading a file', 'Read a file'],
  folder: ['Listing a folder', 'Listed a folder'],
  talk: ['Messaging', 'Messaged'],
  manager: ['Briefing the manager', 'Briefed the manager'],
  commission: ['Commissioning a specialist', 'Commissioned a specialist'],
  delegate: ['Opening delegation', 'Ready to delegate'],
  toolkit: ['Requesting test tools', 'Requested test tools'],
  submit: ['Submitting the work', 'Submitted the work'],
  file: ['Presenting a file', 'Presented a file'],
  skill: ['Reading a skill', 'Read a skill'],
  search: ['Searching the web', 'Searched the web'],
  'tool-search': ['Searching tools', 'Searched tools'],
  'browser-navigate': ['Navigating', 'Visited a page'],
  'browser-click': ['Clicking', 'Clicked'],
  'browser-type': ['Typing', 'Typed'],
  'browser-read': ['Reading the page', 'Read the page'],
  connector: ['Using a connector', 'Used a connector'],
  tool: ['Running a tool', 'Used a tool'],
  image: ['Generating an image', 'Generated an image'],
  video: ['Generating a video', 'Generated a video'],
  speech: ['Reading it aloud', 'Read it aloud'],
  music: ['Composing music', 'Composed music'],
  sfx: ['Making a sound effect', 'Made a sound effect'],
  pdf: ['Creating a PDF', 'Created a PDF'],
  'canvas-open': ['Opening the canvas', 'Opened the canvas'],
};

function stepLabel(kind: ActivityStepKind, running: boolean): string {
  return STEP_LABELS[kind][running ? 0 : 1];
}

/**
 * How one tool NAME resolves: its step kind plus (for connector / generic-tool
 * rows) a display name, a specific label pair, and a connector id for the brand
 * icon. This is the heart of the tool → {icon, label, verb} REGISTRY — a tool the
 * registry knows gets its OWN glyph + phrasing; an unknown tool gets the NEUTRAL
 * generic `tool` kind (puzzle glyph + humanized name), NEVER the file read.
 */
export interface ToolResolution {
  readonly kind: ActivityStepKind;
  /** Overrides the kind's default [running, done] label pair (e.g. "Set a reminder"). */
  readonly label?: readonly [running: string, done: string];
  /** For `connector`: the connector id used to resolve the brand icon SVG. */
  readonly connectorId?: string;
  /** Display name for the label ("Reminders", "Linear", or a humanized tool name). */
  readonly displayName?: string;
}

/** A connector-kind resolution, wiring an action label to a connector's brand icon. */
function connectorTool(
  connectorId: string,
  displayName: string,
  label: readonly [string, string],
): ToolResolution {
  return { kind: 'connector', connectorId, displayName, label };
}

/**
 * EXACT tool-name → resolution registry. First-party builtins + the macOS
 * connectors get a distinct glyph, label, and (for connectors) their brand mark.
 * Everything not matched here falls through to the heuristics + the neutral
 * generic fallback in {@link resolveTool}.
 */
const TOOL_REGISTRY: Record<string, ToolResolution> = {
  // file read
  read: { kind: 'read' },
  /*
   * A FOLDER IS NOT A FILE. `ls` had no entry, so listing a directory rendered
   * as "Read a file — buggyapp" with a file icon. Small, but a trace that
   * mislabels what it did is a trace you cannot lean on, and this is the very
   * first row of most runs. Same kind (the reveal and icon behave), honest verb.
   */
  ls: { kind: 'folder' },
  list_dir: { kind: 'folder' },
  listdir: { kind: 'folder' },
  view: { kind: 'read' },
  open_file: { kind: 'read' },
  read_file: { kind: 'read' },
  cat: { kind: 'read' },
  /*
   * THE CORP COMM TOOLS. They had no entries, so every hand-off rendered as the
   * neutral "Used a tool" puzzle glyph with a generic reveal — the user, looking at
   * a run: "it 'commisions specialist' but I can't click on that to see what the
   * commision was, what specialist it was or anything specific."
   *
   * A registry entry is what gives a row its own verb AND its own openable
   * detail, so these are the rows that carry the actual coordination: who was
   * asked, and what for.
   */
  talk_to: { kind: 'talk' },
  /*
   * THE CEO→MANAGER CHANNEL. This entry was missing for three runs: the merge
   * of create_production_hierarchy + speak_to_manager into ONE bidirectional
   * `talk_to_manager` renamed the tool, and the registry still listed only the
   * pre-merge names — so the row that PROVES a run delegated rendered as the
   * neutral "Running a tool" puzzle glyph. the user, looking at a live run: "I
   * thought we fixed this UI thing."
   *
   * The legacy name is kept because old session JSONLs replay through here and
   * would otherwise degrade to the same generic row.
   */
  talk_to_manager: { kind: 'manager' },
  create_production_hierarchy: { kind: 'manager' },
  commission_specialist: { kind: 'commission' },
  ready_to_delegate: { kind: 'delegate' },
  request_test_tools: { kind: 'toolkit' },
  submit_work: { kind: 'submit' },
  // shell
  bash: { kind: 'bash' },
  shell: { kind: 'bash' },
  run: { kind: 'bash' },
  exec: { kind: 'bash' },
  run_command: { kind: 'bash' },
  // python / code execution
  python_run: { kind: 'python' },
  python: { kind: 'python' },
  run_python: { kind: 'python' },
  execute_python: { kind: 'python' },
  // tool search (the harness `tool_search` builtin — the tool registry, not the web)
  tool_search: { kind: 'tool-search' },
  search_tools: { kind: 'tool-search' },
  // on-device image generation + editing (harness image tools). Both are EXACT
  // entries because `edit_image` would otherwise be swallowed by the edit/write
  // heuristic below and render as a file edit instead of a picture.
  generate_image: { kind: 'image' },
  /*
   * The rest of the generate family. Without these the row read "Used a tool"
   * over a picture of a waveform — the least informative sentence available,
   * next to the most informative object on the screen.
   */
  generate_video: { kind: 'video' },
  generate_speech: { kind: 'speech' },
  generate_music: { kind: 'music' },
  generate_sfx: { kind: 'sfx' },
  edit_image: { kind: 'image', label: ['Editing an image', 'Edited an image'] },
  // web search
  web_search: { kind: 'search' },
  brave_search: { kind: 'search' },
  google: { kind: 'search' },
  search_web: { kind: 'search' },
  // macOS Calendar
  calendar_create_event: connectorTool('mac-calendar', 'Calendar', [
    'Creating an event',
    'Created an event',
  ]),
  calendar_list_events: connectorTool('mac-calendar', 'Calendar', [
    'Reading the calendar',
    'Read the calendar',
  ]),
  // macOS Mail
  mail_send: connectorTool('mac-mail', 'Mail', ['Sending an email', 'Sent an email']),
  mail_search: connectorTool('mac-mail', 'Mail', ['Searching Mail', 'Searched Mail']),
  mail_recent: connectorTool('mac-mail', 'Mail', ['Reading Mail', 'Read Mail']),
  mail_read: connectorTool('mac-mail', 'Mail', ['Reading a message', 'Read a message']),
  // macOS Messages
  messages_send: connectorTool('mac-messages', 'Messages', ['Sending a message', 'Sent a message']),
  messages_recent: connectorTool('mac-messages', 'Messages', ['Reading messages', 'Read messages']),
  // macOS Contacts
  contacts_search: connectorTool('mac-contacts', 'Contacts', [
    'Searching Contacts',
    'Searched Contacts',
  ]),
  // macOS Reminders
  reminders_create: connectorTool('mac-reminders', 'Reminders', [
    'Setting a reminder',
    'Set a reminder',
  ]),
  reminders_list: connectorTool('mac-reminders', 'Reminders', [
    'Reading reminders',
    'Read reminders',
  ]),
  // A manager's CONTRACT, surfaced as a "Commissioned <title>" tool-call row when
  // corp-blocks detects a contract ARRAY in the feed (D1) — one row per contract,
  // the raw JSON never dumped. Neutral `tool` kind: the reveal shows the contract
  // fields (Input); the collapsed row reads "Commissioned" + the contract title.
  commission_contract: { kind: 'tool', displayName: 'Commissioned' },
};

/** Tool-name prefix (before the first `_`/`.`) → its macOS connector identity. */
const CONNECTOR_PREFIXES: Record<string, { id: string; name: string }> = {
  calendar: { id: 'mac-calendar', name: 'Calendar' },
  mail: { id: 'mac-mail', name: 'Mail' },
  messages: { id: 'mac-messages', name: 'Messages' },
  contacts: { id: 'mac-contacts', name: 'Contacts' },
  reminders: { id: 'mac-reminders', name: 'Reminders' },
};

/** Title-case a connector id/slug for display ("google-calendar" → "Google Calendar"). */
function humanizeConnectorId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Humanize a raw tool name for the neutral fallback ("mcp__srv__do_thing" →
 * "Do thing", "summarize_document" → "Summarize document"). */
function humanizeToolName(name: string): string {
  const tail = name.split(/__|\./).filter(Boolean).pop() ?? name;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  if (words.length === 0) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Resolve an MCP-namespaced tool (`mcp__<server>__<tool>`, `<server>__<tool>`,
 * `<server>.<tool>`) to a connector row: its brand mark when `simple-icons` has
 * the server, else a neutral connector row named after the server. Returns null
 * for a non-namespaced name.
 */
function resolveMcpConnector(name: string): ToolResolution | null {
  const parts = name.split(/__|\./).filter(Boolean);
  if (parts.length < 2) return null;
  let server = (parts[0] ?? '').toLowerCase();
  if (server === 'mcp' && parts.length >= 3) server = (parts[1] ?? '').toLowerCase();
  if (server.length === 0) return null;
  const hasBrand = connectorIconSvg(server) !== undefined;
  return {
    kind: 'connector',
    ...(hasBrand ? { connectorId: server } : {}),
    displayName: humanizeConnectorId(server),
  };
}

/**
 * Resolve a tool name to its {@link ToolResolution}. Exact registry first, then
 * name heuristics (edit/write, browser namespace, image/pdf, read-ish file
 * inspection), then connector-prefix + MCP-namespace detection, and finally the
 * NEUTRAL generic `tool` fallback. Crucially the fallback is `tool`, NOT `read`:
 * an unrecognized tool never masquerades as "Read a file".
 */
export function resolveTool(rawName: string): ToolResolution {
  const name = rawName ?? '';
  const n = name.toLowerCase();

  const exact = TOOL_REGISTRY[n];
  if (exact !== undefined) return exact;

  // Edit/write family (before read-ish, so write_file → edit not read).
  if (
    n.includes('edit') ||
    n.includes('write') ||
    n === 'create' ||
    n === 'update' ||
    n === 'str_replace' ||
    n === 'str_replace_editor' ||
    n.includes('apply_patch') ||
    n.includes('patch')
  )
    return { kind: 'edit' };

  if (n.includes('web_search') || n.includes('search_web')) return { kind: 'search' };
  if (n === 'tool_search' || n.includes('search_tools') || n.includes('find_tools'))
    return { kind: 'tool-search' };
  if (/(^|_)python(_|$)/.test(n)) return { kind: 'python' };

  // Browser-use tool steps (round-10 #17/#9): keep them OFF the generic file
  // "read" glyph. Detected inside the browser/playwright/puppeteer namespace, then
  // split by verb so each renders its own icon + label (compass/pointer/keyboard/
  // eye) instead of a wrong "Read a file" row.
  if (n.includes('browser') || n.includes('playwright') || n.includes('puppeteer')) {
    if (/navigate|goto|go_to|open|visit|url|back|forward|reload|refresh/.test(n))
      return { kind: 'browser-navigate' };
    if (/type|fill|input|press|key|sendkeys|clear/.test(n)) return { kind: 'browser-type' };
    if (/click|tap|hover|select|choose|drag|check|scroll|swipe|mouse/.test(n))
      return { kind: 'browser-click' };
    return { kind: 'browser-read' };
  }

  if (n.includes('image') || n === 'dalle' || n === 'generate_image' || n === 'imagegen')
    return { kind: 'image' };
  if (n.includes('pdf')) return { kind: 'pdf' };

  // Genuinely read-ish FILE inspection (the authoritative read op names +
  // cat/ls/glob/grep/find/head/tail/stat/tree): a file-preview step that expands
  // its output inline. NOT a catch-all — an unknown tool never lands here.
  if (/(^|_)(read|cat|ls|list|glob|grep|rg|ripgrep|find|head|tail|stat|tree|read_dir)(_|$)/.test(n))
    return { kind: 'read' };

  // Connector by tool-name prefix (calendar_/mail_/reminders_/…).
  const prefix = n.split(/[_.]/)[0] ?? '';
  const pfx = CONNECTOR_PREFIXES[prefix];
  if (pfx !== undefined) return { kind: 'connector', connectorId: pfx.id, displayName: pfx.name };

  // MCP-namespaced (server__tool / server.tool / mcp__server__tool).
  const mcp = resolveMcpConnector(name);
  if (mcp !== null) return mcp;

  // NEUTRAL fallback: a generic tool row, humanized name + puzzle glyph.
  return { kind: 'tool', displayName: humanizeToolName(name) };
}

/** Classify a tool name into a step kind (drives icon + summary phrasing). */
export function toolStepKind(name: string): ActivityStepKind {
  return resolveTool(name).kind;
}

/** The row label for a resolved tool, past/present tense. Connector + generic
 * rows read from the resolved display name; the rest use {@link STEP_LABELS}. */
function labelFor(kind: ActivityStepKind, resolution: ToolResolution, running: boolean): string {
  if (resolution.label !== undefined) return resolution.label[running ? 0 : 1];
  if (kind === 'connector') {
    const nm = resolution.displayName ?? 'a connector';
    return running ? `Using ${nm}` : `Used ${nm}`;
  }
  if (kind === 'tool') return resolution.displayName ?? stepLabel('tool', running);
  return stepLabel(kind, running);
}

/**
 * Arg key carrying an ALREADY-FORMATTED reveal body. Set only by the corp
 * bridge, which formats at the engine boundary rather than shipping raw tool
 * arguments over IPC; underscored so it can never collide with a real parameter.
 */
export const PROSE_ARGS_KEY = '__prose';

/**
 * Arg key carrying a step's measured wall-clock, ms. Set only by the corp bridge,
 * which times each call by its tool-call id at the process boundary.
 *
 * The collapsed chain sums per-step durations, and corp steps carried none — so a
 * forty-step corp turn read "Worked" with no time while the identical chain in the
 * ordinary chat read "Worked for 2m 5s". the user: "which doesn't have the time next
 * to it for some reason? 'worked for ah nm rs' please."
 */
export const DURATION_ARG_KEY = '__durationMs';

/**
 * Pretty-print a tool call's arguments for the reveal (Input block).
 *
 * THE COORDINATION TOOLS GET PROSE, NOT JSON. the user: "the talk to, ready to
 * delegate additionally need to be clickable to show case specific not generic
 * expansions of details of the tool call." A hand-off's content is one
 * recipient and one paragraph; rendering that as `{"recipient": "engineer:1",
 * "message": "…\n…"}` buries the only two facts that matter behind escaped
 * newlines. These are the rows that carry what a corp run actually decided, so
 * they read as what they are.
 */
function formatArgs(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length === 0) return undefined;
  /*
   * A corp role's call arrives already prose-formatted (the engine formats it at
   * the process boundary — see corpArgsText — rather than shipping raw tool
   * arguments across IPC). Honour it verbatim so a role chat's reveal is
   * identical to the same call's reveal in the ordinary chat.
   */
  const prose = args[PROSE_ARGS_KEY];
  if (typeof prose === 'string' && prose.length > 0) return prose;
  const comm = formatCommArgs(args);
  if (comm !== undefined) return comm;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return undefined;
  }
}

/** The corp comm tools, rendered as "Field: value" + the body on its own lines. */
function formatCommArgs(args: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const push = (label: string, v: unknown): void => {
    const t = str(v);
    if (t !== undefined && t.length > 0) lines.push(`${label}: ${t}`);
  };
  push('To', args.recipient);
  push('Specialist', args.specialty);
  push('Testing', args.what_you_will_test);
  // talk_to_manager: why a team, and the shape the CEO had in mind (optional —
  // leaving divisions out and letting the manager split the work is the norm).
  push('Why a team', args.reason);
  if (Array.isArray(args.divisions)) {
    for (const d of args.divisions) {
      if (d === null || typeof d !== 'object') continue;
      const rec = d as Record<string, unknown>;
      const purpose = str(rec.purpose);
      lines.push(
        `Division: ${str(rec.name) ?? '?'}${purpose !== undefined ? ` — ${purpose}` : ''}`,
      );
    }
  }
  // request_test_tools: each kit with the reason it was asked for.
  if (Array.isArray(args.kits)) {
    for (const k of args.kits) {
      if (typeof k === 'string') lines.push(`Kit: ${k}`);
      else if (k !== null && typeof k === 'object') {
        const rec = k as Record<string, unknown>;
        const why = str(rec.why);
        lines.push(`Kit: ${str(rec.kit) ?? '?'}${why !== undefined ? ` — ${why}` : ''}`);
      }
    }
  }
  const body = str(args.message) ?? str(args.request) ?? str(args.plan_summary);
  if (lines.length === 0 && body === undefined) return undefined;
  if (body !== undefined) {
    if (lines.length > 0) lines.push('');
    lines.push(body);
  }
  return lines.join('\n');
}

/**
 * WHICH ELEMENT a browser click/type acted on.
 *
 * There is no agreement between browser tools on what to call it — Playwright
 * takes a `selector`, the computer-use tools take a `ref` or an `element`
 * description, and several accept a plain accessible `label`. Any of them
 * answers "what did it click", so any of them will do; a coordinate pair is the
 * last resort, because "(412, 380)" is at least a place.
 */
function browserTarget(args: Record<string, unknown>): string | undefined {
  const named =
    str(args.selector) ??
    str(args.ref) ??
    str(args.element) ??
    str(args.element_description) ??
    str(args.label) ??
    str(args.aria_label) ??
    str(args.name);
  if (named !== undefined) return named;
  const coord = args.coordinate;
  if (Array.isArray(coord) && coord.length >= 2 && coord.every((n) => typeof n === 'number')) {
    return `(${coord[0]}, ${coord[1]})`;
  }
  const x = args.x;
  const y = args.y;
  return typeof x === 'number' && typeof y === 'number' ? `(${x}, ${y})` : undefined;
}

/**
 * The text a `browser-type` step entered. Deliberately NOT `str()`-guarded on
 * emptiness: clearing a field is a real action with an empty string as its
 * argument, and reporting nothing there would make a clear look like a no-op.
 */
function browserTyped(args: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'value', 'input', 'keys', 'key'] as const) {
    const v = args[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** The most meaningful single arg to surface inline for a connector/tool row. */
function primaryArg(args: Record<string, unknown>): string | undefined {
  return (
    str(args.query) ??
    str(args.q) ??
    // WHO a hand-off went to, so the row itself reads "Messaged engineer:1"
    // rather than making you open it to learn the one fact you wanted.
    str(args.recipient) ??
    str(args.specialty) ??
    str(args.title) ??
    str(args.name) ??
    str(args.subject) ??
    str(args.url) ??
    pickPath(args)
  );
}

/** Build a best-effort DiffFileData[] from an edit tool's arguments. */
function editDiff(args: Record<string, unknown>): DiffFileData[] | undefined {
  const path = pickPath(args) ?? 'file';
  const oldText = str(args.old_string ?? args.oldText ?? args.old ?? args.oldStr);
  const newText = str(
    args.new_string ??
      args.newText ??
      args.new ??
      args.newStr ??
      args.content ??
      args.contents ??
      args.text ??
      args.file_text,
  );
  if (oldText === undefined && newText === undefined) return undefined;
  const lines: DiffLine[] = [];
  if (oldText !== undefined)
    for (const l of oldText.split('\n')) lines.push({ kind: 'del', text: l });
  if (newText !== undefined)
    for (const l of newText.split('\n')) lines.push({ kind: 'add', text: l });
  return [
    {
      path,
      added: newText !== undefined ? newText.split('\n').length : 0,
      deleted: oldText !== undefined ? oldText.split('\n').length : 0,
      lines,
    },
  ];
}

/** Rows + an optional backend note parsed from a web-search tool result. */
interface ParsedSearch {
  results: WebSearchResultData[];
  note?: string;
}

function toSearchRow(r: Record<string, unknown>): WebSearchResultData {
  const url = str(r.url) ?? str(r.link);
  return {
    title: str(r.title) ?? str(r.name) ?? url ?? 'Result',
    url,
    domain: str(r.domain) ?? hostOf(url),
    snippet: str(r.snippet) ?? str(r.description) ?? str(r.content) ?? str(r.text),
  };
}

/** JSON array / `{ results: [...] }` shapes (what MCP + API search tools emit). */
function tryJsonRows(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    const rows = (parsed as { results?: unknown } | null)?.results;
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the built-in web_search text body — a header, an optional "(note: …)"
 * line, then "[n] title / url / snippet" blocks — into rows + note. This is the
 * real path in the app: the engine forwards only the tool's TEXT (not its
 * structured `details`), and that text is a human-readable list, not JSON — so a
 * JSON-only parser always yielded [] and every search rendered "0 results".
 */
function parseSearchText(text: string): ParsedSearch {
  const rows: WebSearchResultData[] = [];
  let note: string | undefined;
  let cur: { title: string; url?: string; snippet?: string } | undefined;
  const flush = (): void => {
    if (cur === undefined) return;
    rows.push({ title: cur.title, url: cur.url, domain: hostOf(cur.url), snippet: cur.snippet });
    cur = undefined;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const head = /^\[(?:\d+)\]\s+(.*)$/.exec(line);
    if (head !== null) {
      flush();
      cur = { title: head[1] ?? '' };
      continue;
    }
    if (cur === undefined) {
      const m = /^\(note:\s*(.*?)\)\s*$/.exec(line);
      if (m !== null) note = m[1];
      continue; // header / note / blank lines before the first result
    }
    if (line.length === 0) continue;
    if (cur.url === undefined && /^https?:\/\//i.test(line)) {
      cur.url = line;
      continue;
    }
    cur.snippet = cur.snippet !== undefined ? `${cur.snippet} ${line}` : line;
  }
  flush();
  return { results: rows.slice(0, 20), note };
}

/** Parse a web-search tool result into rows + note, tolerant of JSON and text. */
function parseSearchOutcome(result: ToolResultMsg | undefined): ParsedSearch {
  if (result === undefined || result.text.length === 0) return { results: [] };
  const rows = tryJsonRows(result.text);
  if (rows !== undefined) {
    return {
      results: rows.slice(0, 20).map((raw) => toSearchRow((raw ?? {}) as Record<string, unknown>)),
    };
  }
  return parseSearchText(result.text);
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Schemes a media surface can actually LOAD: a data URI, the web, or the app's
 * own `pd-file://` media scheme (canvas-main.ts), which streams bytes off disk.
 * `pd-file:` is how the on-device image tools return a 1 MB PNG without base64ing
 * it into the transcript and the model's context.
 */
const MEDIA_URL_RE = /^(data:|https?:|pd-file:)/;

/**
 * The first loadable media URL in a tool result's text.
 *
 * Scanned LINE BY LINE rather than tested whole, because a result may pair the
 * URL with human/model-facing text (the image tools return the `pd-file://` URL
 * on line 1 and the plain disk path on line 2). Single-line results — the shape
 * every previous image tool returned — are unaffected, and no media URL contains
 * a newline.
 */
/**
 * The absolute path a generation tool reported writing.
 *
 * These tools take no path ARGUMENT — you ask for a sound, not for a file — and
 * they name what they made in prose: "Generated 1 audio file:\n  1. /Users/…
 * /cand0_seed769838462_000.wav (seed …)". So the row has nothing to show for
 * itself unless the path is read back out of the result, which is what leaves a
 * "Made a sound effect" step with no file, no source and nothing to open.
 *
 * Two passes, because a home directory may contain a SPACE ("/Users/Ada
 * Lovelace/Bobble/…") and a rule that stops at whitespace would hand back half
 * a path — which reads as correct and opens nothing. The listed form is
 * matched first, taking everything up to the trailing "(seed …)"; the loose
 * scan is the fallback for a tool that phrases its result some other way.
 */
/**
 * The facts a generation reported about itself — the model that made it and the
 * seed it used, the two things you reach for when a take is worth repeating or
 * worth never seeing again.
 *
 * They are in the result text, but as prose across three lines, and HTML
 * collapses newlines: rendered raw it becomes "Generated 1 audio file: 1.
 * /Users/… (seed 769838462) Model: qwen3-tts-1.7b" on one line. Parsed, they
 * lay out like every other reveal in the chain.
 */
export function reportedFacts(
  text: string | undefined,
): { label: string; value?: string; mono?: boolean }[] {
  if (text === undefined) return [];
  const model = /^\s*Model:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const seed = /\bseed\s+(\d+)/i.exec(text)?.[1];
  return [
    { label: 'Model', value: model },
    { label: 'Seed', value: seed, mono: true },
  ];
}

export function reportedOutputPath(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const listed = /^\s*\d+\.\s+(\/.+?)(?:\s+\(seed\b|\s*$)/m.exec(text)?.[1];
  if (listed !== undefined) return listed.trim();
  /*
   * NOT A SLASH INSIDE A URL. "pd-file://f/Users/x/out.wav" contains the
   * substring "/f/Users/x/out.wav", which looks exactly like an absolute path
   * and is not one — this scan handed it back, and the row then showed a
   * location no file has ever been at. A candidate must start at whitespace or
   * the start of a line, never mid-token.
   */
  return /(?<![:\w/])(\/[^\s()]+\.[A-Za-z0-9]{2,5})/.exec(text)?.[1];
}

export function firstMediaUrl(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (MEDIA_URL_RE.test(trimmed)) return trimmed;
  }
  return undefined;
}

/** A media/preview src the canvas tab shows (data URI, http(s), pd-file, else a path). */
function pickMediaSrc(
  args: Record<string, unknown>,
  result: ToolResultMsg | undefined,
): string | undefined {
  const fromResult = firstMediaUrl(str(result?.text));
  if (fromResult !== undefined) return fromResult;
  /*
   * THE PATH THE TOOL NAMED, made loadable.
   *
   * `generate_image` takes no path ARGUMENT and its result names the file in
   * prose — no `pd-file://` URL anywhere in it — so both branches below came
   * back empty and the canvas tab opened on nothing: "Failed to load file
   * content", under the title "PNG" because the filename was equally absent.
   * MEASURED in the app on a real generate_image turn (the picture was fine in
   * the thread the whole time; only the tab it opened was broken).
   *
   * A bare disk path cannot be rendered by an <img>, which is what that surface
   * is, so it has to become the app's own file URL to be worth anything.
   */
  const named = reportedOutputPath(str(result?.text));
  if (named !== undefined) return pdFileUrl(named);
  const fromArgs = str(args.url) ?? str(args.src) ?? pickPath(args);
  return fromArgs;
}

/**
 * The renderable src for a generated-IMAGE tool result, or undefined when the
 * result isn't an inline-displayable image. Round-5 #7: generated images render
 * INLINE in the thread (a bounded thumbnail → click for a fullscreen preview),
 * diverging from the reference apps that route them to the canvas. Only a real
 * URL qualifies ({@link MEDIA_URL_RE}) — a bare disk path can't be shown inline,
 * which is why the image tools return a `pd-file://` URL beside the path.
 */
export function generatedImageSrc(
  block: ToolCallBlock,
  result: ToolResultMsg | undefined,
): string | undefined {
  if (toolStepKind(block.name) !== 'image') return undefined;
  // Only the RESULT can carry a renderable image; an argument path never can.
  return firstMediaUrl(str(result?.text));
}

/**
 * A REJECTED CALL IS NOT WORK DONE.
 *
 * Run G: six `edit` calls, every one rejected, the file never written — and the
 * collapsed thread summarised the turn as "Ran a command, thought for 15s,
 * edited 6 files, read 9 files". `isError` was on the result the whole time and
 * simply never reached the step, so a failure was indistinguishable from a
 * success everywhere in the chain.
 *
 * The count itself was true — six calls were made. What made it a lie was
 * "edited", a verb that asserts the file changed. {@link summarizeActivity} now
 * says what actually happened to them.
 */
export function mapToolStep(
  block: ToolCallBlock,
  result: ToolResultMsg | undefined,
  running: boolean,
): MappedStep {
  const step = mapToolStepData(block, result, running);
  /*
   * A MEASURED duration, when the corp bridge attached one. The chain sums these
   * for its collapsed line, and corp steps had none — so a forty-step corp turn
   * read a bare "Worked" while the identical chain in the ordinary chat read
   * "Worked for 2m 5s".
   */
  const measured = (block.arguments as Record<string, unknown> | undefined)?.[DURATION_ARG_KEY];
  const withDuration =
    typeof measured === 'number' && measured > 0
      ? { ...step, data: { ...step.data, durationMs: measured } }
      : step;
  if (result?.isError !== true) return withDuration;
  return { ...withDuration, data: { ...withDuration.data, failed: true } };
}

/** Map one tool-call block (+ its result) to a chain step and optional canvas tab. */
function mapToolStepData(
  block: ToolCallBlock,
  result: ToolResultMsg | undefined,
  running: boolean,
): MappedStep {
  const args = block.arguments ?? {};
  // Resolve the tool through the registry (its OWN icon + label + verb), then —
  // for a read whose target is a SKILL / tool-instructions file — reclassify the
  // generic `read` to the distinct `skill` kind (Wave B #3a). Only a read-ish
  // tool is promoted; an edit to a skill file stays an edit.
  const resolution = resolveTool(block.name);
  let kind = resolution.kind;
  const path = pickPath(args);
  if (kind === 'read' && isSkillPath(path)) kind = 'skill';
  const filename = baseName(path);
  const status = running ? 'running' : 'done';
  const label = labelFor(kind, resolution, running);
  // The step's PRIMARY arg, surfaced inline next to the verb (the user round-2 #2):
  // "Read a file: <path>", "Ran: <cmd>", "Searched: <query>". The UI shows a
  // path's basename on the collapsed row and the full value in the reveal.
  const command = str(args.command) ?? str(args.code) ?? str(args.script) ?? str(args.source);
  const query = str(args.query) ?? str(args.q);
  const url = str(args.url) ?? str(args.href) ?? str(args.link);

  switch (kind) {
    case 'bash':
      return {
        data: { kind, label, status, detail: command, command, output: str(result?.text) },
      };
    case 'python':
      return {
        data: { kind, label, status, detail: command, command, output: str(result?.text) },
      };
    case 'edit': {
      // A tool call that carried its content produces a real diff (±stat derived
      // from it). A live write reported only as line COUNTS (the corp feed's file
      // step, which has the growing +N/−N but not the bytes) passes them through
      // explicit `addedLines`/`removedLines` args so the ±stat still counts up —
      // real edit tool calls never carry those keys, so normal chat is unchanged.
      let added = typeof args.addedLines === 'number' ? args.addedLines : undefined;
      let deleted = typeof args.removedLines === 'number' ? args.removedLines : undefined;
      const diff = editDiff(args);
      let editPath = path;
      let editName = filename;
      // Still streaming (args haven't parsed): read the growing whole-file content
      // out of the raw argsText and count its lines, so +N ticks up in real time
      // and matches the canvas draw. str_replace edits carry no `content` field, so
      // this only fires for whole-file writes; parsed edits keep the real diff.
      if (diff === undefined && running && block.argsText !== undefined) {
        const p = partialJsonString(block.argsText, PATH_KEYS);
        const c = partialJsonString(block.argsText, CONTENT_KEYS);
        if (p?.complete === true) {
          editPath = p.value;
          editName = baseName(p.value);
        }
        if (c !== undefined && c.value.length > 0) {
          added = c.value.split('\n').length;
          deleted = 0;
        }
      }
      return {
        data: {
          kind,
          label,
          status,
          detail: editPath,
          filename: editName,
          ...(diff !== undefined ? { diff } : {}),
          ...(added !== undefined ? { added } : {}),
          ...(deleted !== undefined ? { deleted } : {}),
        },
      };
    }
    case 'search': {
      const { results, note } = parseSearchOutcome(result);
      return {
        data: {
          kind,
          label,
          status,
          detail: query,
          query,
          results,
          // Surfaced by the empty state so "0 results" explains itself (e.g. a
          // rate-limit note) instead of being a silent dead-end.
          note,
        },
      };
    }
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-type':
    case 'browser-read':
      return {
        data: {
          kind,
          label,
          status,
          detail: url,
          url,
          /*
           * WHAT WAS CLICKED, AND WHAT WAS TYPED. These were dropped on the
           * floor: the step carried only a URL, so a click row could name the
           * action and never its object, and the text a `type` step put into a
           * form existed nowhere in the UI at all. Now that the browser rows
           * expand, the reveal has somewhere to put them.
           */
          target: browserTarget(args),
          typed: kind === 'browser-type' ? browserTyped(args) : undefined,
          title: str(args.title),
          pageStatus: str(args.status) ?? str(args.statusText),
          // Only the read/snapshot step expands the page text it returned.
          preview: kind === 'browser-read' ? str(result?.text) : undefined,
        },
      };
    case 'image':
    case 'pdf': {
      const src = pickMediaSrc(args, result);
      const mediaType = kind === 'pdf' ? 'PDF' : 'PNG';
      // The tab is titled with the file, falling back to the bare type only when
      // there is genuinely no name to use — "PNG · PNG" tells you nothing.
      const mediaName = filename ?? baseName(reportedOutputPath(str(result?.text)));
      return {
        // `src` rides along even though `opensInCanvas` is set: it is what the
        // step can still name about itself if it ever reaches the chain without
        // a canvas destination (B1 deliberately keeps the tab even for a missing
        // src, so today that is a fallback rather than a live path).
        data: { kind, label, status, filename: mediaName, src, opensInCanvas: true },
        tabSpec: {
          kind,
          key: block.id,
          title: mediaName ?? mediaType,
          mediaSrc: src,
          mediaType,
          // Intentionally UNCONTROLLED: MediaPreviewSurface derives load/loaded/
          // error from the media element's own events. Seeding a controlled
          // status here froze it on the spinner (B1) — a missing src now falls
          // to the surface's self-managed error path.
        },
      };
    }
    case 'skill':
      // A skill/instructions read: same inline-preview shape as a file read, but
      // its own kind → "Read a skill" + sparkle glyph in the chain.
      return {
        data: { kind: 'skill', label, status, detail: path, filename, preview: str(result?.text) },
      };
    case 'connector':
      // "Used <connector icon> <connector name>": the connector's brand mark
      // (mcp-lite connector-icons) + a name-derived label. The reveal shows the
      // raw call args (Input) + the tool result (Output).
      return {
        data: {
          kind: 'connector',
          label,
          status,
          detail: primaryArg(args),
          ...(resolution.connectorId !== undefined
            ? { iconSvg: connectorIconSvg(resolution.connectorId) }
            : {}),
          argsText: formatArgs(args),
          output: str(result?.text),
        },
      };
    case 'tool-search':
    case 'tool':
    /*
     * THE COORDINATION KINDS BELONG HERE, not in the default arm.
     *
     * `default:` hardcodes `kind: 'read'`, so a kind that reaches it is
     * RELABELLED a file read with a file icon and a `preview` — which is
     * exactly the mislabelling the comment below warns about, applied to the
     * rows that carry a run's whole coordination story. Their args ARE the
     * content (who, and what was asked), so they take the same arm as any
     * tool whose reveal is its input and output.
     */
    case 'talk':
    case 'manager':
    case 'commission':
    case 'delegate':
    case 'toolkit':
    case 'submit':
      // tool_search + the NEUTRAL generic fallback: a distinct glyph + humanized
      // name, args + result revealed on click. NEVER a mislabeled "Read a file".
      return {
        data: {
          kind,
          label,
          status,
          detail: primaryArg(args),
          argsText: formatArgs(args),
          output: str(result?.text),
        },
      };
    /*
     * A LISTING IS NOT A FILE READ. `ls`/`list_dir`/`listdir` resolve to
     * `folder`, but the arm below hardcodes `kind: 'read'` — so every directory
     * listing reached the chain relabelled as a read, wearing the file-sheet
     * glyph, while the open-folder icon drawn for exactly this case was never
     * reachable. Same body as a read (a path plus the text it returned); the
     * kind is the whole point.
     */
    case 'folder':
      return {
        data: { kind: 'folder', label, status, detail: path, filename, preview: str(result?.text) },
      };
    /*
     * THE GENERATE FAMILY: an artifact row, not a file-read row.
     *
     * These rows do not route to the canvas — the clip or picture is already
     * mounted in the thread beneath them — so `src` is not a canvas target
     * here. It is what the row can say for itself when opened: where the file
     * it made actually landed.
     */
    case 'video':
    case 'speech':
    case 'music':
    case 'sfx': {
      /*
       * THE PLAIN PATH WINS over a `pd-file://` URL when the tool reports both.
       * This row's only use for it is a line a person reads and copies, and
       * "pd-file://f/Users/…" is this app's internal address for the same file.
       * The URL is the fallback, for a generator that returns nothing else.
       *
       * `preview` keeps the tool's own words for the same fallback reason — the
       * seed and the model are what you reach for when a take is worth
       * repeating, and a generator this app cannot parse still has them.
       */
      const produced = reportedOutputPath(str(result?.text)) ?? firstMediaUrl(str(result?.text));
      const src = produced ?? path;
      return {
        data: {
          kind,
          label,
          status,
          /*
           * THE HEADER SHOWS THE FILENAME, not the path. The row's inline
           * detail truncates from the RIGHT — "…/bobble-can-speak-now-14/
           * cand0_seed2…" — so a full path spends the whole line on the
           * directory and cuts off the one part you were looking for. The
           * location is a click away in the reveal.
           */
          detail: filename ?? baseName(produced) ?? path,
          filename: filename ?? baseName(produced),
          preview: str(result?.text),
          facts: reportedFacts(str(result?.text)),
          ...(src !== undefined ? { src } : {}),
        },
      };
    }
    default:
      /*
       * PASS THE REAL KIND THROUGH.
       *
       * This arm used to hardcode `kind: 'read'`, which was fine while every
       * kind reaching it WAS read-ish — and silently wrong for each one added
       * since. The label is computed from the true kind, so the row read "Read
       * it aloud" while the collapsed summary, which aggregates by kind, said
       * "read a file" about a turn that read nothing. MEASURED: steps
       * ["Thought", "Read it aloud", "Thought", "Done"] under the summary
       * "Thought for 2s, read a file".
       *
       * The shape here is the generic one (label + detail + preview), so every
       * kind that lands in this arm renders identically — only the icon and the
       * summary phrase change, which is exactly what was broken.
       */
      return {
        data: { kind, label, status, detail: path, filename, preview: str(result?.text) },
      };
  }
}

/**
 * Map a thinking block to a chain step (thought text expands inline). An
 * optional `durationMs` (derived from turn/tool timing by the caller — the
 * engine carries no per-block timestamps) feeds the aggregated summary line so
 * it can read "thought for Xm Ys". Only a positive value is attached.
 */
/*
 * CHAT-TEMPLATE MARKERS ARE NOT THOUGHTS.
 *
 * the user, from a screenshot of a live run: three "Thought" rows in a row whose
 * entire visible content was `<|channel>thought`.
 *
 * MEASURED in that run's session log — the model prefixes its reasoning with a
 * template marker, and often emits NOTHING ELSE:
 *
 *   block=thinking len=18   '<|channel>thought\n'
 *   block=thinking len=1643 '<|channel>thought\nThe previous edit call failed…'
 *
 * So a real thought carried a junk first line, and an empty one became a row
 * that said only the marker. Both are stripped here rather than in the delta
 * stream, where the marker arrives split across chunks and cannot be matched.
 *
 * The pattern is deliberately loose — `<|channel>`, `<|channel|>`, `<|start|>`,
 * with or without a trailing word — because these are model-family artefacts
 * that vary, and none of them is ever content a person should read.
 */
const TEMPLATE_MARKER = /^\s*<\|[a-z_]+\|?>\s*[a-z_]*\s*\n?/i;

export function cleanThought(text: string): string {
  let out = text;
  // A model can stack them ("<|start|><|channel>analysis"); strip until settled.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TEMPLATE_MARKER, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** A thinking block with nothing but a marker in it — a row that says nothing. */
export function isEmptyThinking(block: { type: string; thinking?: string }): boolean {
  return block.type === 'thinking' && cleanThought(block.thinking ?? '').length === 0;
}

export function mapThinkingStep(
  block: ThinkingBlock,
  running: boolean,
  durationMs?: number,
): MappedStep {
  return {
    data: {
      kind: 'thinking',
      label: stepLabel('thinking', running),
      status: running ? 'running' : 'done',
      ...(cleanThought(block.thinking).length > 0 ? { thought: cleanThought(block.thinking) } : {}),
      ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    },
  };
}

/**
 * Which blocks of a chain are RUNNING (present-tense) vs SETTLED (past-tense) —
 * the single source of truth for the tense of every step (E1).
 *
 * Root-cause fix: only the LAST block of a LIVE (streaming) chain may go
 * present-tense via the streaming fallback; every earlier block stays PAST tense
 * even when it has no result yet. The old rule ("no result AND streaming")
 * re-lit EVERY resultless step present the instant a new action started — so
 * "Edited a file" reverted to "Editing a file" across the whole chain. Now a
 * settled prior step reads "Edited a file" / "Thought" / "Ran a command" and only
 * the current/last one reads "Editing a file" / "Thinking…".
 *
 * A tool the engine explicitly reports as in-flight (`runningToolCalls`) is
 * always present (normal chat's authoritative signal, unchanged). A thinking
 * block runs only while it is the trailing block of a live turn. Pure + tested.
 */
export function chainRunningFlags(
  blocks: readonly ActivityBlock[],
  opts: {
    streaming: boolean;
    hasResult: (id: string) => boolean;
    runningToolCalls: readonly string[];
  },
): boolean[] {
  const lastIdx = blocks.length - 1;
  return blocks.map((block, i) => {
    const isLast = i === lastIdx;
    if (block.type === 'thinking') return opts.streaming && isLast;
    if (opts.runningToolCalls.includes(block.id)) return true;
    return opts.streaming && isLast && !opts.hasResult(block.id);
  });
}
