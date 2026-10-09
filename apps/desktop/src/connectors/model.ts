/**
 * ONE ITEM MODEL over the real stores — what the Connectors screen draws.
 *
 * An {@link Item} is a catalog connector, a custom server the catalog does not
 * know, or a skill; each carries one {@link ItemState}. Nothing here is
 * fiction: every field comes from `useConnectorsStore` / `useSkillsStore` /
 * `useSettingsStore`, and every action in {@link useActions} is the same IPC
 * round-trip the screen has always made.
 *
 * Also here: the tool cache (a server is started ONCE, when it is turned on,
 * and its tools remembered across launches), the failure record every surface
 * reads (so a server that would not start is amber on its row, on its tile in
 * the Installed strip and in its detail, never a green "Installed"), the
 * prompt-cost arithmetic, the page's sections, and the authored copy — reach
 * lines, key help, and the example prompt each connector's detail leads with.
 */

import type {
  ConnectorCategory,
  KnownConnector,
  McpMode,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';
import { sayIfRaw } from '@pi-desktop/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  ConnectorToolListing,
  ModuleConnectorState,
} from '../../electron/connectors/connectors-contract';
import type { SkillListItem } from '../../electron/skills/skills-contract';
import { installedServer, useConnectorsStore } from '../state/connectors-store';
import { usePiStore } from '../state/pi-slice';
import { useSettingsStore } from '../state/settings-store';
import { useSkillsStore } from '../state/skills-store';

/**
 * - builtin      always on, never a process (the mac-* tools, HyperFrames…)
 * - on           installed and enabled
 * - off          installed, switched off by the user
 * - needs-setup  installed but a key / folder placeholder is still unfilled,
 *                so it was landed disabled and cannot run yet
 * - available    in the catalog, not installed
 */
export type ItemState = 'builtin' | 'on' | 'off' | 'needs-setup' | 'available';

export interface ConnectorItem {
  readonly kind: 'connector';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly connector: KnownConnector;
  readonly server: McpServerConfig | undefined;
  readonly state: ItemState;
  /** Why the /Applications scan recommended it ("Blender.app is installed"). */
  readonly reason: string | undefined;
  /** The last listing failed and nothing has succeeded since (see the tool cache). */
  readonly failure: ToolFailure | undefined;
}

/** A server added by hand — the catalog knows nothing about it. */
export interface CustomItem {
  readonly kind: 'custom';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly server: McpServerConfig;
  readonly state: 'on' | 'off';
  readonly failure: ToolFailure | undefined;
}

export interface SkillItem {
  readonly kind: 'skill';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skill: SkillListItem;
  readonly state: 'on' | 'available';
}

export type Item = ConnectorItem | CustomItem | SkillItem;

export const CUSTOM_PREFIX = 'custom:';
export const SKILL_PREFIX = 'skill:';

/** Renderer-safe mirror of mcp-lite's connectorNeedsConfig. */
export function needsConfig(c: KnownConnector): boolean {
  if (c.requiresEnv !== undefined && c.requiresEnv.length > 0) return true;
  return (c.template.args ?? []).some((a) => /<[^>]+>/.test(a));
}

/**
 * What is still unfilled before this connector can run: env keys with no value
 * and `<PLACEHOLDER>` args. Reads the installed server when there is one, so a
 * key the user has pasted no longer counts.
 */
export function unfilled(c: KnownConnector, server: McpServerConfig | undefined): string[] {
  const out: string[] = [];
  for (const key of c.requiresEnv ?? []) {
    const value = server?.env?.[key];
    if (value === undefined || value.trim() === '') out.push(key);
  }
  const args = server?.args ?? c.template.args ?? [];
  for (const a of args) {
    const m = /<([^>]+)>/.exec(a);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** An env key is a secret; a `<PLACEHOLDER>` arg (a folder, a URL) is not. */
export function isSecretField(c: KnownConnector, field: string): boolean {
  return (c.requiresEnv ?? []).includes(field);
}

function connectorState(
  c: KnownConnector,
  server: McpServerConfig | undefined,
  installedModels: ReadonlySet<string> = new Set(),
  moduleConnectors: Readonly<Record<string, ModuleConnectorState>> = {},
): ItemState {
  if (c.kind === 'builtin') return 'builtin';
  /* A model connector is never in the registry; its files are its install. */
  if (c.kind === 'model') return installedModels.has(c.id) ? 'on' : 'available';
  /* A module connector is on when its engine is here AND it was turned on —
     the same condition its tools register on. Anything less is "available",
     which is what puts it under "Recommended for you" with its reason. */
  if (c.kind === 'module') {
    const m = moduleConnectors[c.id];
    return m?.ready && m.on ? 'on' : 'available';
  }
  if (server === undefined) return 'available';
  if (server.enabled !== false) return 'on';
  return unfilled(c, server).length > 0 ? 'needs-setup' : 'off';
}

// ───────────────────────────── attention ─────────────────────────────

/**
 * A server that is ON and whose last listing failed. The switch is honestly
 * on — the registry says so — but the server is not usable. Not a sixth
 * ItemState (the switch would lie the other way); a fact beside the state,
 * and every surface that shows the state asks this first.
 */
export function failing(item: Item): boolean {
  return item.kind !== 'skill' && item.state === 'on' && item.failure !== undefined;
}

/** Needs setup, or on and failing: what the "Needs attention" pill and group count. */
export function needsAttention(item: Item): boolean {
  return item.state === 'needs-setup' || failing(item);
}

/**
 * How a listing failed, read from the host's own sentence. A spawn error or
 * an exit before the handshake is a server that COULD NOT START; only a
 * timeout is one that did not answer. The two used to share "Not responding",
 * which told a person with a missing `uvx` to wait.
 */
export type FailureKind = 'start' | 'timeout' | 'other';

export function classifyFailure(error: string): FailureKind {
  if (/timed out/i.test(error)) return 'timeout';
  if (/ENOENT|EACCES|spawn |exited \(code|not found|no such file|is not installed/i.test(error)) {
    return 'start';
  }
  return 'other';
}

/**
 * The failure in plain words, from the server's own stderr where it wrote
 * any ("GitHub API: 401 Bad credentials"), else from the host's message.
 */
export function failureReason(f: Pick<ToolFailure, 'error' | 'stderr'>): string {
  const last = f.stderr?.at(-1);
  if (last !== undefined && last.trim() !== '') return last;
  const spawn = /spawn (\S+) ENOENT/.exec(f.error);
  if (spawn?.[1] !== undefined) return `${spawn[1]} is not installed, or not on the PATH.`;
  const exit = /exited \(code ([^)]+)\)/.exec(f.error);
  if (exit?.[1] !== undefined) return `The process exited (code ${exit[1]}) before it answered.`;
  const timeout = /timed out after (\d+)ms/.exec(f.error);
  if (timeout?.[1] !== undefined) {
    return `No answer within ${Math.round(Number(timeout[1]) / 1000)} seconds.`;
  }
  return f.error;
}

/** A failing server's ledger line: the failure, dated, in place of what it touches. */
export function failureLine(item: Item): string | null {
  if (item.kind === 'skill' || item.failure === undefined || !failing(item)) return null;
  const verb = item.failure.kind === 'timeout' ? 'Did not answer' : 'Could not start';
  return `${verb} · tried ${agoLabel(item.failure.at)}`;
}

/** Whether this connector takes a key — the fix a failing one is offered. */
export function hasKeys(item: Item): boolean {
  return item.kind === 'connector' && (item.connector.requiresEnv ?? []).length > 0;
}

/**
 * The row's second line when something is wrong — in amber, in place of the
 * description. A row carries one control (`+` or `···`), so this line is
 * where a server that needs a key, or would not start, says so.
 */
export function attentionLine(item: Item): string | null {
  const failed = failureLine(item);
  if (failed !== null) return failed;
  if (item.state === 'needs-setup') {
    return hasKeys(item) ? 'Needs a key before it can run' : 'Needs setup before it can run';
  }
  return null;
}

/** Yours: added, whether it is on, off or waiting for a key. A skill counts once it is on. */
export function isInstalled(item: Item): boolean {
  return item.state === 'on' || item.state === 'off' || item.state === 'needs-setup';
}

/**
 * What a failing server's status line says. A key-needing server's likeliest
 * failure is the key (a 401 is what the real server exits on), so it goes
 * back to "Needs setup"; otherwise the kind of failure, in its own words.
 */
export function failureLabel(item: Item): 'Needs setup' | 'Could not start' | 'Not responding' {
  if (hasKeys(item)) return 'Needs setup';
  const kind = item.kind === 'skill' ? 'other' : (item.failure?.kind ?? 'other');
  return kind === 'timeout' ? 'Not responding' : 'Could not start';
}

/**
 * The server config that results from filling in `values` (keyed by env key or
 * placeholder name) — installs when not yet installed, and turns it on.
 */
export function applySetup(item: ConnectorItem, values: Record<string, string>): McpServerConfig {
  const base: McpServerConfig = item.server ?? { ...item.connector.template, enabled: true };
  const args = (base.args ?? []).map((a) => {
    const m = /^<([^>]+)>$/.exec(a);
    const v = m?.[1] !== undefined ? values[m[1]] : undefined;
    return v !== undefined && v.trim() !== '' ? v.trim() : a;
  });
  const env: Record<string, string> = { ...(base.env ?? {}) };
  for (const key of item.connector.requiresEnv ?? []) {
    const v = values[key];
    if (v !== undefined && v.trim() !== '') env[key] = v.trim();
  }
  return {
    ...base,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    enabled: true,
  };
}

/**
 * Where a key comes from — the setup card says where the key GOES, and a
 * person who has never made one needs the other half of the sentence.
 */
export interface KeyHelp {
  readonly text: string;
  readonly url?: string;
}

const KEY_HELP: Record<string, KeyHelp> = {
  github: {
    text: 'Create a token at github.com › Settings › Developer settings',
    url: 'https://github.com/settings/tokens',
  },
  notion: {
    text: 'Create an integration at notion.so/my-integrations and copy its secret',
    url: 'https://www.notion.so/my-integrations',
  },
  slack: {
    text: 'A user token (xoxp-…) from an app at api.slack.com',
    url: 'https://api.slack.com/apps',
  },
  figma: {
    text: 'Figma › Settings › Security › Personal access tokens',
    url: 'https://www.figma.com/developers/api#access-tokens',
  },
  postman: {
    text: 'Postman › Settings › API keys',
    url: 'https://go.postman.co/settings/me/api-keys',
  },
  'brave-search': {
    text: 'Get a key at api.search.brave.com',
    url: 'https://api.search.brave.com/app/keys',
  },
  discord: {
    text: 'A bot token from the Discord Developer Portal',
    url: 'https://discord.com/developers/applications',
  },
  spotify: {
    text: 'Client ID and secret from the Spotify Developer Dashboard',
    url: 'https://developer.spotify.com/dashboard',
  },
  tableau: {
    text: 'A personal access token from Tableau › My Account Settings',
    url: 'https://help.tableau.com/current/server/en-us/security_personal_access_tokens.htm',
  },
  obsidian: {
    text: 'The API key shown in the Local REST API plugin’s settings inside Obsidian',
    url: 'https://github.com/coddingtonbear/obsidian-local-rest-api',
  },
  postgres: { text: 'A connection string, like postgresql://user:pass@localhost:5432/db' },
  'google-drive': {
    text: 'The path to an OAuth credentials JSON from Google Cloud Console',
    url: 'https://console.cloud.google.com/apis/credentials',
  },
  gmail: {
    text: 'The path to an OAuth credentials JSON from Google Cloud Console',
    url: 'https://console.cloud.google.com/apis/credentials',
  },
  'google-calendar': {
    text: 'The path to an OAuth credentials JSON from Google Cloud Console',
    url: 'https://console.cloud.google.com/apis/credentials',
  },
};

export function keyHelp(c: KnownConnector): KeyHelp | undefined {
  return KEY_HELP[c.id];
}

// ───────────────────────────── reach ─────────────────────────────

/**
 * One plain sentence about what it touches. Explicit for every key-needing
 * connector — the derived sentence was the one ledger row that truncated at
 * the pane's width — and under {@link REACH_MAX} so the row never needs an
 * ellipsis.
 */
export const REACH_MAX = 44;

const REACH_LINE: Record<string, string> = {
  github: 'Signs in with your GitHub token',
  postman: 'Signs in with your Postman API key',
  notion: 'Signs in with your Notion token',
  slack: 'Signs in with your Slack user token',
  figma: 'Signs in with your Figma API key',
  'google-drive': 'Reads Google Drive with your credentials',
  gmail: 'Reads and sends Gmail with your credentials',
  'google-calendar': 'Signs in to Google Calendar with OAuth',
  tableau: 'Signs in to Tableau with your access token',
  'brave-search': 'Searches the web with your Brave API key',
  spotify: 'Signs in with your Spotify app credentials',
  discord: 'Signs in with your Discord bot token',
  'mac-calendar': 'Reads and creates events in Calendar',
  'mac-mail': 'Reads mail in Mail',
  'mac-messages': 'Reads and sends iMessages',
  'mac-contacts': 'Reads Contacts',
  'mac-reminders': 'Reads and creates Reminders',
  hyperframes: 'Renders video on this Mac (ffmpeg + headless Chrome)',
  'video-editing': 'Edits video files with ffmpeg',
  memory: 'Keeps a knowledge graph in a local file',
  'sequential-thinking': 'Touches nothing: a reasoning scratchpad',
  time: 'Touches nothing: clocks and time zones',
  git: 'Reads and writes a Git repository',
  sqlite: 'Reads a local SQLite file',
  playwright: 'Drives a browser it launches itself',
  'chrome-devtools': 'Attaches to Google Chrome',
  obsidian: 'Reads your vault through Obsidian’s local REST API',
  postgres: 'Queries a Postgres database',
  docker: 'Controls Docker on this Mac',
  xcode: 'Builds and tests with Xcode',
  blender: 'Drives Blender scenes and rendering',
  unity: 'Drives the Unity editor',
};

/**
 * A skill's one line. Its description is a paragraph for the search and the
 * detail; twelve authored lines under {@link REACH_MAX} for the card and the
 * ledger row. A skill the table does not know falls back to its description.
 */
const SKILL_LINE: Record<string, string> = {
  'code-review': 'Reviews diffs for bugs and cleanups',
  'data-analysis': 'Explores and summarises tabular data',
  debugging: 'Reproduces, isolates and fixes a bug',
  'doc-coauthoring': 'Co-writes specs, proposals and docs',
  'git-workflow': 'Branches, commits, PRs and recoveries',
  'internal-comms': 'Drafts updates, reports and FAQs',
  'mcp-builder': 'Scaffolds an MCP server, Python or Node',
  'pdf-toolkit': 'Reads, splits, merges and fills PDFs',
  'spreadsheet-toolkit': 'Reads, edits and formats spreadsheets',
  'web-research': 'Researches a question with cited sources',
  'webapp-testing': 'Drives and tests local web apps',
  'writing-docs': 'Writes READMEs, guides and references',
};

export function skillLine(skill: Pick<SkillListItem, 'id' | 'description'>): string {
  return SKILL_LINE[skill.id] ?? skill.description;
}

/** The second line of a ledger row: what it touches, or what a skill does. */
export function ledgerLine(item: Item): string {
  if (item.kind === 'connector') return reachLine(item.connector, item.server);
  if (item.kind === 'custom') return `Runs ${item.server.command} · added by you`;
  return skillLine(item.skill);
}

/** The card's second line: a skill's one line, a connector's description, a custom server's "Runs …". */
export function cardLine(item: Item): string {
  return item.kind === 'skill' ? skillLine(item.skill) : item.description;
}

export function reachLine(c: KnownConnector, server: McpServerConfig | undefined): string {
  const explicit = REACH_LINE[c.id];
  if (explicit !== undefined) return explicit;
  const args = server?.args ?? c.template.args ?? [];
  if (c.id === 'filesystem') {
    const dir = args.find((a) => a.startsWith('/') || a.startsWith('~'));
    // The home folder as `~`: the one ledger row that truncated was this
    // path, and `/Users/user/` is the part a person already knows.
    return dir !== undefined
      ? `Reads and writes files under ${dir.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')}`
      : 'Reads and writes files in a folder you choose';
  }
  const remote = args.find((a) => /^https?:\/\//.test(a));
  if (remote !== undefined) {
    try {
      return `Talks to ${new URL(remote).host}`;
    } catch {
      return `Talks to ${remote}`;
    }
  }
  const keys = c.requiresEnv ?? [];
  const app = c.appBundles?.[0]?.replace(/\.app$/, '');
  if (keys.length > 0) {
    const first = keys[0] ?? '';
    const brand = c.name.split(/\s+/)[0] ?? c.name;
    const kind = /TOKEN/.test(first) ? 'token' : /API_KEY/.test(first) ? 'API key' : 'key';
    return keys.length === 1
      ? `Signs in with your ${brand} ${kind}`
      : `Signs in with ${keys.length} ${brand} values`;
  }
  if (app !== undefined) return `Works with ${app} on this Mac`;
  return 'Runs locally';
}

/** A server that is a local bridge to something remote (`mcp-remote`, or a URL in its args). */
export function isRemote(server: Pick<McpServerConfig, 'args'>): boolean {
  const args = server.args ?? [];
  return args.includes('mcp-remote') || args.some((a) => /^https?:\/\//.test(a));
}

// ───────────────────────────── the example ─────────────────────────────

/**
 * What this connector lets you ask for, in the person's own words — the
 * outcome, before the inventory. The references lead their detail pages with
 * a picture of a conversation; the local, offline equivalent is one real ask
 * and a button that starts a chat with it. Authored per catalog entry; an
 * unknown or hand-added server derives one from its first tool.
 */
const EXAMPLE_PROMPT: Record<string, string> = {
  omnisvg: 'Make me an SVG icon of a red heart with smooth curved edges, centered.',
  'bobble-3d': 'Make me a 3D model of a low-poly fox sitting, then rig it.',
  filesystem: 'List the files in my Projects folder and summarise what each project is.',
  git: 'What changed in this repo in the last week? Summarise the commits.',
  memory:
    'Remember that the client meeting moved to Thursday, then tell me what you know about the client.',
  'sequential-thinking':
    'Think it through step by step: plan a three-day trip to Kyoto on a budget.',
  time: 'What time is it in Tokyo right now, and when is 9am there in my time zone?',
  github: 'List my open pull requests and summarise the ones waiting on my review.',
  postgres: 'Which tables are in the database, and how many rows does the largest one have?',
  sqlite: 'Open the SQLite file and show me the ten most recent orders.',
  playwright: 'Open example.com in a browser, take a screenshot, and tell me what the page says.',
  'chrome-devtools': 'Open the page I have in Chrome and check its console for errors.',
  postman: 'List my Postman collections and run the smoke-test collection.',
  sentry: 'What are the most frequent errors in production this week?',
  xcode: 'Build the app in this folder for the simulator and report any warnings.',
  docker: 'Which containers are running, and how much memory is each one using?',
  notion: 'Find my notes on the Q3 launch in Notion and turn them into a checklist.',
  linear: 'What is assigned to me in Linear this cycle? Group it by priority.',
  slack: 'Summarise what happened in #general this week.',
  figma: 'Describe the layout of the selected Figma frame and suggest a component structure.',
  'google-drive': 'Find the latest budget spreadsheet in my Drive and summarise the totals.',
  gmail: 'Show me unread emails from this week and draft replies to the urgent ones.',
  'google-calendar': 'What is on my calendar tomorrow? Find a free hour for a call.',
  tableau: 'List the dashboards on my Tableau site and pull the sales-by-region numbers.',
  obsidian: 'Search my vault for notes about the migration and write a summary note.',
  'brave-search': 'Search the web for the latest MCP spec changes and summarise them.',
  blender: 'Add a cube to the scene, give it a red material, and render a preview.',
  unity: 'List the scenes in the project and add a directional light to the active one.',
  spotify: 'Play my Focus playlist and tell me what is playing.',
  discord: 'Post a summary of today’s changes to the #updates channel.',
  zoom: 'List my upcoming Zoom meetings and pull the transcript of yesterday’s standup.',
  'mac-calendar': 'What is on my calendar this week? Add lunch with Sam on Friday at noon.',
  'mac-mail': 'Find the email from the accountant about invoices and summarise it.',
  'mac-messages': 'Text Sam that I am running ten minutes late.',
  'mac-contacts': 'What is Sam’s phone number?',
  'mac-reminders': 'Remind me to call the dentist tomorrow at 9.',
  hyperframes: 'Make a ten-second animated title card that says “Launch day”.',
  'video-editing': 'Trim the first five seconds off intro.mp4 and export it as a GIF.',
  'skill:code-review': 'Review the diff in this repo for bugs before I open the PR.',
  'skill:data-analysis': 'Load sales.csv and tell me which region grew fastest.',
  'skill:debugging': 'The app crashes on launch — reproduce it and find the cause.',
  'skill:doc-coauthoring': 'Help me draft the spec for the new export feature.',
  'skill:git-workflow': 'Create a branch for this fix and open a PR when it is ready.',
  'skill:internal-comms': 'Write the weekly status update for the team from these notes.',
  'skill:mcp-builder': 'Scaffold an MCP server in Python that wraps the weather API.',
  'skill:pdf-toolkit': 'Merge these three PDFs and fill in the form fields on page 2.',
  'skill:spreadsheet-toolkit': 'Add a totals row and a chart to budget.xlsx.',
  'skill:web-research': 'Research the best local-first note apps and cite your sources.',
  'skill:webapp-testing': 'Test the login flow on localhost:3000 and report what breaks.',
  'skill:writing-docs': 'Write a README for this project with install and usage sections.',
};

export function examplePrompt(item: Item, tools: readonly Tool[]): string {
  const authored = EXAMPLE_PROMPT[item.id];
  if (authored !== undefined) return authored;
  const serverId = serverIdOf(item) ?? undefined;
  const first = tools.find((t) => toolVerb(t.name) === 'looks-up') ?? tools[0];
  if (first !== undefined) {
    return `Use ${item.name} to ${humanizeTool(first.name, serverId).toLowerCase()} for me.`;
  }
  return `Use ${item.name} in this chat.`;
}

// ───────────────────────────── tools ─────────────────────────────

export type ToolVerb = 'looks-up' | 'changes';

const LOOKS_UP =
  /^(list|get|search|read|recent|probe|query|fetch|find|describe|show|status|check|inspect|lookup|view|count|resolve|browse)(_|$)|_(list|get|search|read|find|query|recent)(_|$)/;

/**
 * Read-only or not, GUESSED FROM THE NAME. MCP has no read/write annotation
 * that servers reliably fill in, so this is a heuristic and every surface that
 * shows it says so. Good enough to make "what can this change?" scannable.
 */
export function toolVerb(name: string): ToolVerb {
  return LOOKS_UP.test(name.toLowerCase()) ? 'looks-up' : 'changes';
}

const ACRONYMS: Record<string, string> = {
  pr: 'PR',
  prs: 'PRs',
  url: 'URL',
  urls: 'URLs',
  api: 'API',
  id: 'ID',
  ids: 'IDs',
  sql: 'SQL',
  html: 'HTML',
  json: 'JSON',
  csv: 'CSV',
  pdf: 'PDF',
  db: 'DB',
  ui: 'UI',
  http: 'HTTP',
  css: 'CSS',
  js: 'JS',
  ai: 'AI',
  ip: 'IP',
  mcp: 'MCP',
  cli: 'CLI',
  '3d': '3D',
};

/**
 * `list_channel_members` / `getFileContents` → "List channel members". The
 * identifier is what the model calls; the sentence is what a person reads.
 * A server's own `<id>_` prefix is dropped so twenty rows do not all open
 * with the same word.
 */
export function humanizeTool(name: string, serverId?: string): string {
  let n = name;
  if (serverId !== undefined && n.startsWith(`${serverId}_`)) n = n.slice(serverId.length + 1);
  const words = n
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return name;
  return words
    .map((w, i) => {
      const acronym = ACRONYMS[w];
      if (acronym !== undefined) return acronym;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    })
    .join(' ');
}

/**
 * `GITHUB_PERSONAL_ACCESS_TOKEN` → "a GitHub personal access token". The raw
 * key belongs in the setup field, where it must be exact; in a sentence it is
 * shouting.
 */
export function humanizeKey(key: string, vendor?: string): string {
  const words = key
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => ACRONYMS[w] ?? w);
  const brand = vendor?.split(/\s+/)[0];
  if (brand !== undefined && words.length > 1 && words[0] === brand.toLowerCase()) {
    words[0] = brand;
  }
  const phrase = words.join(' ');
  return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
}

/** Whether a tool is advertised, given the server's switched-off list. */
export function isToolOn(
  server: Pick<McpServerConfig, 'disabledTools'> | undefined,
  name: string,
): boolean {
  return !(server?.disabledTools ?? []).includes(name);
}

/**
 * What the enabled tools cost the prompt, per turn. Native advertises every
 * schema (the per-tool estimate main computed from the JSON the model sees);
 * Lite sends the catalog line — name and one sentence — and fetches a schema
 * only when the model asks. Both ≈; both said to be so on screen.
 */
export interface ToolCost {
  readonly native: number;
  readonly lite: number;
  readonly on: number;
  readonly total: number;
}

export function toolCost(
  tools: readonly Tool[],
  server: Pick<McpServerConfig, 'disabledTools'> | undefined,
): ToolCost {
  let native = 0;
  let lite = 0;
  let on = 0;
  for (const t of tools) {
    if (!isToolOn(server, t.name)) continue;
    on += 1;
    native += t.tokens ?? Math.ceil((t.name.length + t.description.length + 80) / 4);
    lite += Math.ceil((t.name.length + t.description.length + 6) / 4);
  }
  return { native, lite, on, total: tools.length };
}

/** "≈ 320" / "≈ 2.1k" */
export function formatTokens(n: number): string {
  if (n < 1000) return `≈ ${String(n)}`;
  const k = n / 1000;
  return `≈ ${k >= 10 ? String(Math.round(k)) : k.toFixed(1)}k`;
}

// ───────────────────────────── categories ─────────────────────────────

export const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  files: 'Files',
  dev: 'Developer tools',
  database: 'Databases',
  browser: 'Browser',
  design: 'Design',
  docs: 'Documents and notes',
  project: 'Project management',
  comms: 'Communication',
  analytics: 'Analytics',
  creative: 'Creative',
  media: 'Media',
  devops: 'DevOps',
  search: 'Search',
  observability: 'Observability',
  meetings: 'Meetings and calendar',
};

export const SKILL_CATEGORY_LABEL: Record<string, string> = {
  authoring: 'Authoring',
  dev: 'Developer',
  data: 'Data',
  research: 'Research',
  documents: 'Documents',
  productivity: 'Productivity',
  learning: 'Learning',
};

/** The category in the words the screen uses — the same words the search matches. */
export function categoryOf(item: Item): string {
  if (item.kind === 'connector') return CATEGORY_LABEL[item.connector.category];
  if (item.kind === 'skill')
    return SKILL_CATEGORY_LABEL[item.skill.category] ?? item.skill.category;
  return 'Custom';
}

/**
 * Who a community server is NOT from. The catalog's `official` flag says a
 * server is the vendor's own; the exception is worth a sentence.
 */
const VENDOR: Record<string, string> = {
  'google-drive': 'Google',
  gmail: 'Google',
  'google-calendar': 'Google',
  blender: 'the Blender Foundation',
  unity: 'Unity',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
};

export function vendorOf(c: KnownConnector): string {
  return VENDOR[c.id] ?? c.name;
}

// ───────────────────────────── sections ─────────────────────────────

/**
 * The page's sections: the fifteen catalog categories folded into six, so a
 * category of one ("Search") is not a heading over one row. The order is the
 * order on the page. Within a section the catalog's own order holds — a row
 * never moves because its switch was flipped; what you have is indexed by
 * the Installed strip instead.
 */
export type SectionId = 'dev' | 'data' | 'browse' | 'comms' | 'docs' | 'media';

export const SECTIONS: ReadonlyArray<{
  readonly id: SectionId;
  readonly title: string;
  readonly categories: readonly ConnectorCategory[];
}> = [
  { id: 'dev', title: 'Developer tools', categories: ['dev', 'devops', 'observability'] },
  { id: 'data', title: 'Files and data', categories: ['files', 'database', 'analytics'] },
  { id: 'browse', title: 'Browsing and search', categories: ['browser', 'search'] },
  { id: 'comms', title: 'Communication', categories: ['comms', 'meetings'] },
  { id: 'docs', title: 'Documents and notes', categories: ['docs', 'project'] },
  { id: 'media', title: 'Design and media', categories: ['design', 'creative', 'media'] },
];

export function sectionOf(category: ConnectorCategory): SectionId {
  return SECTIONS.find((s) => s.categories.includes(category))?.id ?? 'dev';
}

/** The vendor's own server, or Bobble's, or neither — the exception is "neither". */
export function isCommunity(c: KnownConnector): boolean {
  return !c.official && c.firstParty !== true;
}

// ───────────────────────────── search ─────────────────────────────

/** "Chrome is installed (browsing is built-in; …)" → "Chrome is installed". */
export function shortReason(reason: string): string {
  return reason.replace(/\s*\(.*$/, '');
}

export function matches(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  // The category LABEL, not only its key: "Developer tools" typed into the
  // search — or put there by the link in a detail's About row — is category
  // browsing with no new surface, and it only works if the words match.
  const hay = [item.name, item.description, item.kind, categoryOf(item)];
  if (item.kind === 'connector') hay.push(item.connector.category, item.connector.id);
  if (item.kind === 'skill') hay.push(item.skill.category, item.skill.source);
  if (item.kind === 'custom') hay.push(item.server.command, ...(item.server.args ?? []));
  return hay.some((h) => h.toLowerCase().includes(q));
}

/** Best-effort developer label from the homepage — the org, not "github.com". */
export function developerOf(c: KnownConnector): string {
  if (c.firstParty === true) return 'Bobble';
  if (c.homepage !== undefined) {
    try {
      const url = new URL(c.homepage);
      const host = url.host.replace(/^www\./, '');
      if (host === 'github.com') {
        const org = url.pathname.split('/').filter(Boolean)[0];
        if (org !== undefined) return org;
      }
      return host;
    } catch {
      // fall through
    }
  }
  return c.official ? 'Vendor' : 'Community';
}

// ───────────────────────────── the tool cache ─────────────────────────────

/** A tool as the screen shows it. `tokens` comes from a live listing; the catalog's static lists have none. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly tokens?: number;
}

/** A server's tool list as it was the last time the server answered. */
export interface CachedTools {
  /** When it answered (epoch ms). */
  readonly at: number;
  /** The command line it answered for — a changed command invalidates the list. */
  readonly cmd: string;
  readonly tools: readonly Tool[];
}

/**
 * Listing a server's tools means SPAWNING it — and in a fresh home `npx -y`
 * downloads it first. So the list is kept across sessions, and it is filled
 * the moment a server is turned on (it is starting then anyway) rather than
 * the moment someone looks: on every later open the pane draws the cached
 * list at once, with a caption saying when it was listed. A switch turning a
 * server off keeps its list — the tools a server has do not change with its
 * switch — and a changed command line drops it.
 */
const TOOL_KEY = 'connectors:tools:';
const memory = new Map<string, CachedTools | null>();
const inflight = new Map<string, Promise<ConnectorToolListing>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The last listing that FAILED, kept beside the list the same way and cleared
 * by the next success. This is what the ledger row, the card's control, the
 * "Needs attention" pill and the detail's status line read. Persisted, because
 * a server that would not start yesterday has not started today either.
 */
export interface ToolFailure {
  readonly at: number;
  readonly cmd: string;
  readonly error: string;
  readonly kind: FailureKind;
  readonly stderr?: string[];
}

const FAIL_KEY = 'connectors:failed:';
const failures = new Map<string, ToolFailure | null>();
/** An immutable copy of `failures`, rebuilt on every change: what `useCatalog` folds into its items. */
let failureSnapshot: ReadonlyMap<string, ToolFailure | null> = new Map();
let failuresLoaded = false;
/** Servers listed at least once THIS session — the warm tries each one once per launch. */
const attempted = new Set<string>();

function parseFailure(raw: string | null): ToolFailure | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<ToolFailure>;
    if (typeof v.at === 'number' && typeof v.cmd === 'string' && typeof v.error === 'string') {
      return {
        at: v.at,
        cmd: v.cmd,
        error: v.error,
        kind: v.kind ?? classifyFailure(v.error),
        ...(Array.isArray(v.stderr)
          ? { stderr: v.stderr.filter((s) => typeof s === 'string') }
          : {}),
      };
    }
  } catch {
    // corrupt: treat as none
  }
  return null;
}

function readFailure(serverId: string): ToolFailure | null {
  const hit = failures.get(serverId);
  if (hit !== undefined) return hit;
  let parsed: ToolFailure | null = null;
  try {
    parsed = parseFailure(window.localStorage.getItem(FAIL_KEY + serverId));
  } catch {
    parsed = null;
  }
  failures.set(serverId, parsed);
  return parsed;
}

/** Every failure persisted last launch, read once so the snapshot is complete before the first render. */
function loadFailures(): void {
  if (failuresLoaded) return;
  failuresLoaded = true;
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k?.startsWith(FAIL_KEY)) readFailure(k.slice(FAIL_KEY.length));
    }
  } catch {
    // no storage: nothing persisted
  }
  failureSnapshot = new Map(failures);
}

function rememberFailure(serverId: string, cmd: string, error: string, stderr?: string[]): void {
  const entry: ToolFailure = {
    at: Date.now(),
    cmd,
    error,
    kind: classifyFailure(error),
    ...(stderr !== undefined && stderr.length > 0 ? { stderr } : {}),
  };
  failures.set(serverId, entry);
  try {
    window.localStorage.setItem(FAIL_KEY + serverId, JSON.stringify(entry));
  } catch {
    // in memory only
  }
  failureSnapshot = new Map(failures);
  notify();
}

function clearFailure(serverId: string): void {
  failures.set(serverId, null);
  try {
    window.localStorage.removeItem(FAIL_KEY + serverId);
  } catch {
    // nothing to clear
  }
  failureSnapshot = new Map(failures);
}

/** The recorded failure for this server, if it failed for this command line. */
export function cachedFailure(serverId: string, cmd: string): ToolFailure | null {
  const hit = readFailure(serverId);
  return hit !== null && hit.cmd === cmd ? hit : null;
}

export function useToolFailure(serverId: string, cmd: string): ToolFailure | null {
  return useSyncExternalStore(
    subscribe,
    () => cachedFailure(serverId, cmd),
    () => null,
  );
}

/** Every server's recorded failure, as one immutable map — re-renders on any change. */
function useFailures(): ReadonlyMap<string, ToolFailure | null> {
  return useSyncExternalStore(
    subscribe,
    () => {
      loadFailures();
      return failureSnapshot;
    },
    () => failureSnapshot,
  );
}

/** Whether a listing is in flight for this server right now — started here, by a turn-on, or by the warm. */
export function useListing(serverId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inflight.has(serverId),
    () => false,
  );
}

function readCache(serverId: string): CachedTools | null {
  const hit = memory.get(serverId);
  if (hit !== undefined) return hit;
  let parsed: CachedTools | null = null;
  try {
    const raw = window.localStorage.getItem(TOOL_KEY + serverId);
    if (raw !== null) {
      const v = JSON.parse(raw) as CachedTools;
      if (typeof v.at === 'number' && typeof v.cmd === 'string' && Array.isArray(v.tools)) {
        parsed = v;
      }
    }
  } catch {
    parsed = null;
  }
  memory.set(serverId, parsed);
  return parsed;
}

export function rememberTools(serverId: string, cmd: string, tools: readonly Tool[]): void {
  const entry: CachedTools = { at: Date.now(), cmd, tools };
  memory.set(serverId, entry);
  try {
    window.localStorage.setItem(TOOL_KEY + serverId, JSON.stringify(entry));
  } catch {
    // Storage full or unavailable: the in-memory copy still serves this session.
  }
  // A success outlives every failure before it — the one ordering rule.
  clearFailure(serverId);
  notify();
}

export function forgetTools(serverId: string): void {
  memory.set(serverId, null);
  try {
    window.localStorage.removeItem(TOOL_KEY + serverId);
  } catch {
    // nothing to forget
  }
  clearFailure(serverId);
  attempted.delete(serverId);
  notify();
}

/** The cached list for this server, if it was listed for this command line. */
export function cachedTools(serverId: string, cmd: string): CachedTools | null {
  const hit = readCache(serverId);
  return hit !== null && hit.cmd === cmd ? hit : null;
}

/** Re-renders when any server's cached list changes. */
export function useCachedTools(serverId: string, cmd: string): CachedTools | null {
  return useSyncExternalStore(
    subscribe,
    () => cachedTools(serverId, cmd),
    () => null,
  );
}

export function commandLine(server: Pick<McpServerConfig, 'command' | 'args'>): string {
  return [server.command, ...(server.args ?? [])].join(' ').trim();
}

/** "just now", "4 min ago", "yesterday" — the caption under a cached list. */
export function agoLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${String(h)} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return `${String(d)} days ago`;
}

/**
 * Start the server once and remember what it lists. One flight per server:
 * a detail opening while the turn-on warm is still running joins it instead
 * of starting a second process.
 */
function listTools(
  fetchTools: Actions['fetchTools'],
  serverId: string,
  cmd: string,
): Promise<ConnectorToolListing> {
  const running = inflight.get(serverId);
  if (running !== undefined) return running;
  attempted.add(serverId);
  const p = fetchTools(serverId)
    .then(
      (res) => {
        // An answer with no tools is an answer ("Tools 0 · listed just now"),
        // not a failure; only an error is a failure.
        if (res.error === undefined) rememberTools(serverId, cmd, res.tools);
        else rememberFailure(serverId, cmd, res.error, res.stderr);
        return res;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        rememberFailure(serverId, cmd, error);
        return { tools: [], error };
      },
    )
    .finally(() => {
      inflight.delete(serverId);
      notify();
    });
  inflight.set(serverId, p);
  notify();
  return p;
}

/** The registry id a live fetch is keyed by — a custom item carries the `custom:` prefix on top. */
export function serverIdOf(item: Item): string | null {
  if (item.kind === 'connector') return item.server !== undefined ? item.id : null;
  if (item.kind === 'custom') return item.server.id;
  return null;
}

/**
 * Fill the cache, in the background, for every server that is on and has no
 * list yet — servers enabled before this cache existed, or by hand in the JSON.
 * One at a time: this is the same set of processes the next chat starts, and
 * it is paid once per server, ever.
 *
 * Once per server PER LAUNCH, to be exact (`attempted`): a server that failed
 * has no list, and without that guard this effect — which re-runs on every
 * registry change — would spawn it again after every toggle on the screen. A
 * failure recorded last launch is retried once at the next, which is what a
 * person expects of a server that would not start yesterday; after that the
 * retry is theirs. Never a needs-setup server: those are `enabled: false`.
 */
export function useWarmTools(cat: Catalog, actions: Actions): void {
  useEffect(() => {
    if (!cat.loaded) return;
    let cancelled = false;
    const pending = cat.items.filter((i) => {
      if (i.state !== 'on' || i.kind === 'skill') return false;
      const id = serverIdOf(i) ?? '';
      if (attempted.has(id)) return false;
      return i.server !== undefined && cachedTools(id, commandLine(i.server)) === null;
    });
    void (async () => {
      for (const item of pending) {
        if (cancelled) return;
        const id = serverIdOf(item);
        if (id === null || item.kind === 'skill' || item.server === undefined) continue;
        await listTools(actions.fetchTools, id, commandLine(item.server)).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cat.loaded, cat.items, actions]);
}

// ───────────────────────────── the hook ─────────────────────────────

export interface Catalog {
  readonly items: readonly Item[];
  readonly connectors: readonly ConnectorItem[];
  readonly customs: readonly CustomItem[];
  readonly skills: readonly SkillItem[];
  readonly loaded: boolean;
  /** The item id an action is in flight for, if any. */
  readonly busyId: string | null;
  readonly mode: McpMode;
  /** Every registry id — the add dialog checks a new name against them. */
  readonly serverIds: ReadonlySet<string>;
}

export function useCatalog(): Catalog {
  const registry = useConnectorsStore((s) => s.registry);
  const catalog = useConnectorsStore((s) => s.catalog);
  const installedModels = useConnectorsStore((s) => s.installedModels);
  const moduleConnectors = useConnectorsStore((s) => s.moduleConnectors);
  const recommended = useConnectorsStore((s) => s.recommended);
  const detected = useConnectorsStore((s) => s.detected);
  const loaded = useConnectorsStore((s) => s.loaded);
  const busy = useConnectorsStore((s) => s.busyId);
  const load = useConnectorsStore((s) => s.load);
  const skills = useSkillsStore((s) => s.skills);
  const skillsLoaded = useSkillsStore((s) => s.loaded);
  const skillsBusy = useSkillsStore((s) => s.busyId);
  const loadSkills = useSkillsStore((s) => s.load);
  const mode = useSettingsStore((s) => s.settings.mcpMode);
  const failuresById = useFailures();

  useEffect(() => {
    void load();
    void loadSkills();
  }, [load, loadSkills]);

  return useMemo(() => {
    const reasons = new Map(recommended.map((r) => [r.id, r.reason]));
    // A failure counts only for the command line it happened on — the same
    // rule as the cached list; a changed command is a different server.
    const failureOf = (server: McpServerConfig): ToolFailure | undefined => {
      const f = failuresById.get(server.id);
      return f !== undefined && f !== null && f.cmd === commandLine(server) ? f : undefined;
    };
    const installedModelIds = new Set(installedModels);
    /* A built-in that drives an APP (Blender) is there only where the app is:
       the scan's own detection, not a card claiming a command this Mac lacks. */
    const detectedIds = new Set(detected.map((d) => d.id));
    const present = catalog.filter(
      (c) => !(c.kind === 'builtin' && (c.appBundles?.length ?? 0) > 0 && !detectedIds.has(c.id)),
    );
    const connectors: ConnectorItem[] = present.map((c) => {
      const server = installedServer(registry, c.id);
      return {
        kind: 'connector',
        id: c.id,
        name: c.name,
        description: c.description,
        connector: c,
        server,
        state: connectorState(c, server, installedModelIds, moduleConnectors),
        reason: reasons.get(c.id),
        failure: server !== undefined ? failureOf(server) : undefined,
      };
    });
    const known = new Set(catalog.map((c) => c.id));
    const customs: CustomItem[] = registry.servers
      .filter((s) => !known.has(s.id))
      .map((s) => ({
        kind: 'custom',
        id: `${CUSTOM_PREFIX}${s.id}`,
        name: s.name,
        // A card's second line is a sentence, not a command line; the path
        // lives in the detail's Command row only.
        description: s.description ?? `Runs ${s.command} · added by you`,
        server: s,
        state: s.enabled !== false ? 'on' : 'off',
        failure: failureOf(s),
      }));
    const skillItems: SkillItem[] = skills.map((sk) => ({
      kind: 'skill',
      id: `${SKILL_PREFIX}${sk.id}`,
      name: sk.name,
      description: sk.description,
      skill: sk,
      state: sk.installed ? 'on' : 'available',
    }));
    return {
      items: [...connectors, ...customs, ...skillItems],
      connectors,
      customs,
      skills: skillItems,
      loaded: loaded && skillsLoaded,
      busyId:
        busy !== null
          ? known.has(busy)
            ? busy
            : `${CUSTOM_PREFIX}${busy}`
          : skillsBusy !== null
            ? `${SKILL_PREFIX}${skillsBusy}`
            : null,
      mode,
      serverIds: new Set(registry.servers.map((s) => s.id)),
    };
  }, [
    registry,
    catalog,
    installedModels,
    moduleConnectors,
    recommended,
    detected,
    loaded,
    busy,
    skills,
    skillsLoaded,
    skillsBusy,
    mode,
    failuresById,
  ]);
}

export interface Actions {
  /** Install a catalog connector that needs no setup (it lands enabled). */
  add: (item: ConnectorItem) => Promise<void>;
  /** Enable / disable an installed thing (a skill installs / uninstalls). */
  setOn: (item: Item, on: boolean) => Promise<void>;
  remove: (item: Item) => Promise<void>;
  /** Fill keys / placeholders and turn it on (installs if needed). */
  setup: (item: ConnectorItem, values: Record<string, string>) => Promise<void>;
  /**
   * Write a server the dialog produced — new, or an edit of one that exists.
   * `listed`: the tools its Test found, remembered so the detail opens with
   * them rather than starting the server a second time.
   */
  saveServer: (server: McpServerConfig, listed?: readonly Tool[]) => Promise<void>;
  /** Switch one of a server's tools on or off for the model. */
  setToolOn: (item: ConnectorItem | CustomItem, tool: string, on: boolean) => Promise<void>;
  setMode: (mode: McpMode) => Promise<void>;
  /** The raw IPC: spawn, list, tear down. Prefer {@link Actions.listTools}. */
  fetchTools: (id: string) => Promise<ConnectorToolListing>;
  /** List a server's tools once and remember them (see the tool cache). */
  listTools: (serverId: string, cmd: string) => Promise<ConnectorToolListing>;
  /** Start a config that is not in the registry and list it — the dialog's Test. */
  probe: (server: McpServerConfig) => Promise<ConnectorToolListing>;
  readSkill: (id: string) => Promise<{ body: string; error?: string }>;
}

/** After a turn-on: list the server's tools now, while it is starting anyway. */
function warmAfter(fetchTools: Actions['fetchTools'], serverId: string): void {
  const server = useConnectorsStore.getState().registry.servers.find((s) => s.id === serverId);
  if (server === undefined || server.enabled === false) return;
  void listTools(fetchTools, serverId, commandLine(server)).catch(() => undefined);
}

export function useActions(): Actions {
  const install = useConnectorsStore((s) => s.install);
  const remove = useConnectorsStore((s) => s.remove);
  const setEnabled = useConnectorsStore((s) => s.setEnabled);
  const upsert = useConnectorsStore((s) => s.upsert);
  const upsertQuiet = useConnectorsStore((s) => s.upsertQuiet);
  const fetchTools = useConnectorsStore((s) => s.fetchTools);
  const probeServer = useConnectorsStore((s) => s.probeServer);
  const toggleSkill = useSkillsStore((s) => s.toggle);
  const readSkill = useSkillsStore((s) => s.readSkill);
  const update = useSettingsStore((s) => s.update);

  const actions: Actions = useMemo(
    () => ({
      add: async (item) => {
        /*
         * A FAILED ADD SAYS SO. The callers fire this and forget it, so a
         * refusal ("the 3D engine is not installed — install it from the 3D
         * studio first") became an unhandled rejection and the button just did
         * nothing (2026-10-08 audit). Now it is a toast in words, with Try again.
         */
        try {
          await install(item.id);
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          usePiStore.setState((st) => ({
            notifications: [
              ...st.notifications.slice(-3),
              {
                id: `connector-${item.id}-${Date.now()}`,
                level: 'error' as const,
                message: `Couldn't add ${item.name}. ${sayIfRaw(raw, 'install')}`,
                timestamp: Date.now(),
                action: { label: 'Try again', run: () => void actions.add(item) },
              },
            ],
          }));
          return;
        }
        warmAfter(fetchTools, item.id);
      },
      setOn: async (item, on) => {
        if (item.kind === 'skill') return toggleSkill(item.skill.id, on);
        const id = item.kind === 'custom' ? item.server.id : item.id;
        await setEnabled(id, on);
        if (on) warmAfter(fetchTools, id);
      },
      remove: (item) => {
        if (item.kind === 'skill') return toggleSkill(item.skill.id, false);
        const id = item.kind === 'custom' ? item.server.id : item.id;
        forgetTools(id);
        return remove(id);
      },
      setup: async (item, values) => {
        await upsert(applySetup(item, values));
        warmAfter(fetchTools, item.id);
      },
      saveServer: async (server, listed) => {
        await upsert(server);
        if (listed !== undefined) rememberTools(server.id, commandLine(server), listed);
        else warmAfter(fetchTools, server.id);
      },
      setToolOn: async (item, tool, on) => {
        const server = item.server;
        if (server === undefined) return;
        const { disabledTools, ...rest } = server;
        const next = new Set(disabledTools ?? []);
        if (on) next.delete(tool);
        else next.add(tool);
        await upsertQuiet(next.size > 0 ? { ...rest, disabledTools: [...next] } : rest);
      },
      setMode: async (mode) => {
        await update({ mcpMode: mode });
      },
      fetchTools,
      listTools: (serverId, cmd) => listTools(fetchTools, serverId, cmd),
      probe: probeServer,
      readSkill,
    }),
    [
      install,
      remove,
      setEnabled,
      upsert,
      upsertQuiet,
      fetchTools,
      probeServer,
      toggleSkill,
      readSkill,
      update,
    ],
  );
  return actions;
}

export const MODE_LABEL: Record<McpMode, string> = {
  lite: 'Lite',
  native: 'Native',
  'bash-cli': 'Bash CLI',
};

export const MODE_HINT: Record<McpMode, string> = {
  lite: 'Bobble is told what each server can do and asks for the tools it needs — the cheapest on the prompt.',
  native:
    'Every tool is sent to the model with its full schema — the most capable and the most expensive.',
  'bash-cli': 'Tools are driven from the terminal through a discoverable --help surface.',
};
