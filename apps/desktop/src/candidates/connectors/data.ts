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
import type { KnownConnector, McpMode, McpServerConfig } from '@pi-desktop/mcp-lite';
import { useEffect, useMemo } from 'react';
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
}

/** A server added by hand — the catalog knows nothing about it. */
export interface CustomItem {
  readonly kind: 'custom';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly server: McpServerConfig;
  readonly state: 'on' | 'off';
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

/** One plain sentence about what it touches. Explicit where a derivation would read badly. */
const REACH_LINE: Record<string, string> = {
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
    return keys.length === 1 ? `Signs in with ${keys[0]}` : `Signs in with ${keys.length} keys`;
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

// ───────────────────────────── search ─────────────────────────────

/** "Chrome is installed (browsing is built-in; …)" → "Chrome is installed". */
export function shortReason(reason: string): string {
  return reason.replace(/\s*\(.*$/, '');
}

export function matches(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [item.name, item.description, item.kind];
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

  useEffect(() => {
    void load();
    void loadSkills();
  }, [load, loadSkills]);

  return useMemo(() => {
    const reasons = new Map(recommended.map((r) => [r.id, r.reason]));
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
      };
    });
    const known = new Set(catalog.map((c) => c.id));
    const customs: CustomItem[] = registry.servers
      .filter((s) => !known.has(s.id))
      .map((s) => ({
        kind: 'custom',
        id: `${CUSTOM_PREFIX}${s.id}`,
        name: s.name,
        description: s.description ?? [s.command, ...(s.args ?? [])].join(' '),
        server: s,
        state: s.enabled !== false ? 'on' : 'off',
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
  }, [registry, catalog, recommended, loaded, busy, skills, skillsLoaded, skillsBusy, mode]);
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
  fetchTools: (
    id: string,
  ) => Promise<{ tools: { name: string; description: string }[]; error?: string }>;
  readSkill: (id: string) => Promise<{ body: string; error?: string }>;
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
      add: (item) => install(item.id),
      setOn: (item, on) => {
        if (item.kind === 'skill') return toggleSkill(item.skill.id, on);
        if (item.kind === 'custom') return setEnabled(item.server.id, on);
        return setEnabled(item.id, on);
      },
      remove: (item) => {
        if (item.kind === 'skill') return toggleSkill(item.skill.id, false);
        if (item.kind === 'custom') return remove(item.server.id);
        return remove(item.id);
      },
      setup: (item, values) => upsert(applySetup(item, values)),
      saveCustom: (server) => upsert(server),
      setMode: async (mode) => {
        await update({ mcpMode: mode });
      },
      fetchTools,
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
