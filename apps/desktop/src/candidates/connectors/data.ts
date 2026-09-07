/**
 * ONE ITEM MODEL over the real stores, shared by every connector candidate.
 *
 * The shipping screen keeps three vocabularies for what the agent can use —
 * "connectors" (the title), "plugins" (the tab), "MCP server" (the detail
 * toggle) — and a fourth surface, Skills, behind a tab. This module reduces
 * all of it to one shape a screen can draw: an {@link Item} is a catalog
 * connector, a custom server the catalog does not know, or a skill; each
 * carries one {@link ItemState}. Nothing here is fiction: every field comes
 * from `useConnectorsStore` / `useSkillsStore` / `useSettingsStore`, and every
 * action in {@link useActions} is the same IPC round-trip the real screen makes.
 */
import type {
  ConnectorCategory,
  KnownConnector,
  McpMode,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SkillListItem } from '../../../electron/skills/skills-contract';
import { installedServer, useConnectorsStore } from '../../state/connectors-store';
import { useSettingsStore } from '../../state/settings-store';
import { useSkillsStore } from '../../state/skills-store';

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

function connectorState(c: KnownConnector, server: McpServerConfig | undefined): ItemState {
  if (c.kind === 'builtin') return 'builtin';
  if (server === undefined) return 'available';
  if (server.enabled !== false) return 'on';
  return unfilled(c, server).length > 0 ? 'needs-setup' : 'off';
}

// ───────────────────────────── attention ─────────────────────────────

/**
 * A server that is ON and whose last listing failed. The switch is honestly
 * on — the registry says so — but the server is not usable, and round 4's
 * judgement found that state drawn as a green "● On" with the failure written
 * in one paragraph of the detail. So it is not a sixth ItemState (the switch
 * would lie the other way); it is a fact beside the state, and every surface
 * that shows the state asks this first.
 */
export function failing(item: Item): boolean {
  return item.kind !== 'skill' && item.state === 'on' && item.failure !== undefined;
}

/** Needs setup, or on and failing: what the "Needs setup" pill and group count. */
export function needsAttention(item: Item): boolean {
  return item.state === 'needs-setup' || failing(item);
}

/**
 * A failing server's ledger line: the failure, dated, in place of what it
 * touches. The row is where the eye rests, and a row that reads "Signs in
 * with your GitHub token" beside an amber pill says which fix, not that one
 * is needed; "Did not answer · tried 4 min ago" says both. What it touches
 * is one click away, in the detail's Reach row.
 */
export function failureLine(item: Item): string | null {
  if (item.kind === 'skill' || item.failure === undefined || !failing(item)) return null;
  return `Did not answer · tried ${agoLabel(item.failure.at)}`;
}

/** Whether this connector takes a key — the fix a failing one is offered. */
export function hasKeys(item: Item): boolean {
  return item.kind === 'connector' && (item.connector.requiresEnv ?? []).length > 0;
}

/**
 * What a failing server's status line says. A key-needing server's likeliest
 * failure is the key (a 401 is what the fixture and the real server both exit
 * on), so it goes back to "Needs setup" and its control goes back to "Set up";
 * anything else is "Not responding" and the control is the retry.
 */
export function failureLabel(item: Item): 'Needs setup' | 'Not responding' {
  return hasKeys(item) ? 'Needs setup' : 'Not responding';
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

// ───────────────────────────── reach ─────────────────────────────

/** What a connector can touch, in the user's terms — the axis the "Reach" candidate groups by. */
export type Reach = 'mac-data' | 'mac-app' | 'account' | 'local';

export const REACH_TITLE: Record<Reach, string> = {
  'mac-data': 'Your Mac',
  'mac-app': 'Apps on this Mac',
  account: 'Accounts and services',
  local: 'Local tools',
};

export const REACH_BLURB: Record<Reach, string> = {
  'mac-data': 'Reads and writes things you keep on this computer.',
  'mac-app': 'Drives an app installed here. Nothing leaves the machine unless the app sends it.',
  account: 'Signs in somewhere with a key you supply. What it can do is what that account allows.',
  local: 'Runs on this Mac and touches nothing of yours unless you point it at something.',
};

const REACH_OVERRIDE: Record<string, Reach> = {
  git: 'mac-data',
  sqlite: 'mac-data',
  obsidian: 'mac-app',
  'chrome-devtools': 'mac-app',
  memory: 'local',
  playwright: 'local',
};

export function reachOf(c: KnownConnector): Reach {
  const o = REACH_OVERRIDE[c.id];
  if (o !== undefined) return o;
  if (c.kind === 'builtin') return c.id.startsWith('mac-') ? 'mac-data' : 'local';
  const args = c.template.args ?? [];
  if (args.includes('mcp-remote') || (c.requiresEnv ?? []).length > 0) return 'account';
  if ((c.appBundles ?? []).length > 0) return 'mac-app';
  if (c.category === 'files' || c.category === 'database' || c.category === 'docs') {
    return 'mac-data';
  }
  return 'local';
}

/**
 * One plain sentence about what it touches. Explicit where a derivation would
 * read badly — and, since round 3, explicit for every key-needing connector:
 * the derived "Signs in with a GitHub personal access token" (44 characters)
 * was the one ledger row that truncated at the pane's designed width. The row's
 * job is the switch and the name; the sentence must never need an ellipsis
 * there, so every line here is under {@link REACH_MAX}.
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
 * A skill's ledger line. Its description is a paragraph for the search and
 * the card ("Review a code change (a diff, PR, or working tree) for
 * correctness bugs and for reuse / simplification / efficiency cleanups.
 * Use when…"), and it was the one ledger row that still ended in an ellipsis
 * at 1440 and at 1152. Twelve authored lines under {@link REACH_MAX}, the
 * rule the connector rows obey; a skill the table does not know falls back to
 * its description, which is at least true.
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

export function reachLine(c: KnownConnector, server: McpServerConfig | undefined): string {
  const explicit = REACH_LINE[c.id];
  if (explicit !== undefined) return explicit;
  const args = server?.args ?? c.template.args ?? [];
  if (c.id === 'filesystem') {
    const dir = args.find((a) => a.startsWith('/') || a.startsWith('~'));
    return dir !== undefined
      ? `Reads and writes files under ${dir}`
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
    // A connector the table above does not know yet: the vendor's first word
    // and the kind of secret, never the shouting identifier and never more
    // than the pane row can hold.
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
};

/**
 * `list_channel_members` / `getFileContents` → "List channel members". The
 * identifier is what the model calls; the sentence is what a person reads —
 * ChatGPT's "Get reactions on a message" is the reference. A server's own
 * `<id>_` prefix is dropped so twenty rows do not all open with the same word.
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
 * shouting. The vendor's own first word is written the way the vendor writes it.
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
 * server is the vendor's own; the exception is worth a sentence, and the
 * sentence needs the vendor's name written the way the vendor writes it.
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

// ───────────────────────────── filters + summary ─────────────────────────────

export type KindFilter = 'all' | 'tools' | 'skills' | 'on' | 'setup';

export const FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills' },
  { id: 'on', label: 'On' },
  { id: 'setup', label: 'Needs setup' },
];

export function passesFilter(filter: KindFilter, item: Item): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tools':
      return item.kind !== 'skill';
    case 'skills':
      return item.kind === 'skill';
    case 'on':
      // "On" is what works; a failing server is in "Needs setup" instead.
      return (item.state === 'on' && !failing(item)) || item.state === 'builtin';
    case 'setup':
      return needsAttention(item);
  }
}

/** The vendor's own server, or Bobble's, or neither — the exception is "neither". */
export function isCommunity(c: KnownConnector): boolean {
  return !c.official && c.firstParty !== true;
}

export interface AgentSummary {
  readonly on: number;
  readonly off: number;
  readonly setup: number;
  readonly skills: number;
  readonly builtin: number;
}

export function summarize(items: readonly Item[]): AgentSummary {
  const s = { on: 0, off: 0, setup: 0, skills: 0, builtin: 0 };
  for (const i of items) {
    if (i.kind === 'skill') {
      if (i.state === 'on') s.skills += 1;
      continue;
    }
    if (failing(i)) s.setup += 1;
    else if (i.state === 'on') s.on += 1;
    else if (i.state === 'off') s.off += 1;
    else if (i.state === 'needs-setup') s.setup += 1;
    else if (i.state === 'builtin') s.builtin += 1;
  }
  return s;
}

/** "4 tools on · 1 needs setup · 1 skill on · 7 built in" */
export function summaryLine(s: AgentSummary): string {
  const parts = [`${s.on} ${s.on === 1 ? 'tool' : 'tools'} on`];
  if (s.setup > 0) parts.push(`${s.setup} ${s.setup === 1 ? 'needs' : 'need'} setup`);
  if (s.off > 0) parts.push(`${s.off} off`);
  parts.push(`${s.skills} ${s.skills === 1 ? 'skill' : 'skills'} on`, `${s.builtin} built in`);
  return parts.join(' · ');
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
  return c.firstParty === true ? 'Bobble' : c.official ? 'Vendor' : 'Community';
}

// ───────────────────────────── the tool cache ─────────────────────────────

export interface Tool {
  readonly name: string;
  readonly description: string;
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
 * downloads it first. Round 2 cached the list per session, so the second look
 * was free and the first look was a spinner; the judge's point was that the
 * first look is the common one. So the list is now kept across sessions, and
 * it is filled the moment a server is turned on (it is starting then anyway)
 * rather than the moment someone looks: on every later open the pane draws the
 * cached list at once, with a caption saying when it was listed. A switch
 * turning a server off keeps its list — the tools a server has do not change
 * with its switch — and a changed command line drops it.
 */
const TOOL_KEY = 'cand-connectors:tools:';
const memory = new Map<string, CachedTools | null>();
const inflight = new Map<string, Promise<{ tools: Tool[]; error?: string }>>();
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
 * "Needs setup" pill and the detail's status line read — round 4's first item
 * was that a failure lived only in the detail's Tools section, as component
 * state, so a bad key left a green "● On" everywhere else. Persisted, because
 * a server that would not start yesterday has not started today either.
 */
export interface ToolFailure {
  readonly at: number;
  readonly cmd: string;
  readonly error: string;
}

const FAIL_KEY = 'cand-connectors:failed:';
const failures = new Map<string, ToolFailure | null>();
/** An immutable copy of `failures`, rebuilt on every change: what `useCatalog` folds into its items. */
let failureSnapshot: ReadonlyMap<string, ToolFailure | null> = new Map();
let failuresLoaded = false;
/** Servers listed at least once THIS session — the warm tries each one once per launch. */
const attempted = new Set<string>();

function parseFailure(raw: string | null): ToolFailure | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as ToolFailure;
    if (typeof v.at === 'number' && typeof v.cmd === 'string' && typeof v.error === 'string') {
      return v;
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

function rememberFailure(serverId: string, cmd: string, error: string): void {
  const entry: ToolFailure = { at: Date.now(), cmd, error };
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
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
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
): Promise<{ tools: Tool[]; error?: string }> {
  const running = inflight.get(serverId);
  if (running !== undefined) return running;
  attempted.add(serverId);
  const p = fetchTools(serverId)
    .then(
      (res) => {
        // An answer with no tools is an answer ("Tools 0 · listed just now"),
        // not a failure; only an error is a failure.
        if (res.error === undefined) rememberTools(serverId, cmd, res.tools);
        else rememberFailure(serverId, cmd, res.error);
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
 * registry change, because `cat.items` is a dependency — spawned it again
 * after every toggle on the screen. MEASURED in round 4 on the bad-key flow:
 * the fixture's GitHub was started twice for one save. A failure recorded
 * last launch is retried once at the next, which is what a person expects of
 * a server that would not start yesterday; after that the retry is theirs.
 * Never a needs-setup server: those are `enabled: false`, so the filter
 * skips them and the main handler would refuse them anyway.
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
}

export function useCatalog(): Catalog {
  const registry = useConnectorsStore((s) => s.registry);
  const catalog = useConnectorsStore((s) => s.catalog);
  const recommended = useConnectorsStore((s) => s.recommended);
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
    const connectors: ConnectorItem[] = catalog.map((c) => {
      const server = installedServer(registry, c.id);
      return {
        kind: 'connector',
        id: c.id,
        name: c.name,
        description: c.description,
        connector: c,
        server,
        state: connectorState(c, server),
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
        // A card's second line is a sentence, not a command line: the ledger
        // row's "Runs node · added by you". The path was the only two-line
        // second line in the Tools grid and it printed a third time in the
        // pane header; it lives in the detail's Command row only.
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
    };
  }, [
    registry,
    catalog,
    recommended,
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
  saveCustom: (server: McpServerConfig) => Promise<void>;
  setMode: (mode: McpMode) => Promise<void>;
  /** The raw IPC: spawn, list, tear down. Prefer {@link Actions.listTools}. */
  fetchTools: (id: string) => Promise<{ tools: Tool[]; error?: string }>;
  /** List a server's tools once and remember them (see the tool cache). */
  listTools: (serverId: string, cmd: string) => Promise<{ tools: Tool[]; error?: string }>;
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
  const fetchTools = useConnectorsStore((s) => s.fetchTools);
  const toggleSkill = useSkillsStore((s) => s.toggle);
  const readSkill = useSkillsStore((s) => s.readSkill);
  const update = useSettingsStore((s) => s.update);

  return useMemo(
    () => ({
      add: async (item) => {
        await install(item.id);
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
      saveCustom: async (server) => {
        await upsert(server);
        warmAfter(fetchTools, server.id);
      },
      setMode: async (mode) => {
        await update({ mcpMode: mode });
      },
      fetchTools,
      listTools: (serverId, cmd) => listTools(fetchTools, serverId, cmd),
      readSkill,
    }),
    [install, remove, setEnabled, upsert, fetchTools, toggleSkill, readSkill, update],
  );
}

export const MODE_LABEL: Record<McpMode, string> = {
  lite: 'Lite',
  native: 'Native',
  'bash-cli': 'Bash CLI',
};

export const MODE_HINT: Record<McpMode, string> = {
  lite: 'Tools are summarised and fetched on demand, so many connectors fit a small context.',
  native: 'Every tool goes to the model with its full schema. Most capable, uses the most context.',
  'bash-cli': 'Tools are driven from the terminal through a discoverable --help surface.',
};
