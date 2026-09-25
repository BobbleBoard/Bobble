/**
 * THE CANONICAL PROMPT AND THE TOOL SURFACE, BYTE FOR BYTE.
 *
 * The frozen system prompt is what the KV prefix cache is keyed on: a change of
 * one byte is a full re-prefill for every chat (memory `user-always-check-prefill`,
 * PLAN.md R8). A refactor that is supposed to change nothing — the W0-A split of
 * `presets/capabilities.ts` into one file per capability — must leave it
 * byte-identical, and "it looks the same" is not a measurement.
 *
 * This drives the real `wireHarness` with a fake pi (every tool the capabilities
 * name, plus pi's own), fires a session and a turn in BOTH tool interfaces, and
 * snapshots what the model would be sent: the canonical system prompt, the
 * advertised tools, every tool definition the harness registered (name,
 * description, parameters), the capability menu and activation texts, and the
 * CLI group list. The snapshot file was written from the code BEFORE the split
 * (6eb58aaf); a change to it is a prompt change and needs the prefix ledger
 * entry and a BENCH TTFT check (PLAN.md §2.11).
 *
 * The files are JSON named `.json.snap`, like vitest's own `.snap` files, so
 * the formatter leaves them alone: `biome check --write` re-indenting one would
 * turn a byte-for-byte record into a failing test.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireHarness } from '../index.js';
import {
  CAPABILITIES,
  capabilityActivated,
  capabilityForTool,
  capabilityMenu,
  findCapability,
} from '../presets/capabilities.js';
import { toolCliGroups } from '../tools/tool-cli-groups.js';

// biome-ignore lint/suspicious/noExplicitAny: event handler shape varies per event.
type AnyHandler = (event: any, ctx: any) => any;

const PI_TOOLS = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'];
const ALL_TOOLS = [...new Set([...PI_TOOLS, ...CAPABILITIES.flatMap((c) => c.tools)])];

/** A pi base prompt shaped like the real one: identity, tools, guidelines, cwd. */
const BASE_PROMPT = [
  'You are an expert coding assistant operating inside pi, a coding agent harness.',
  '',
  'Available tools:',
  '- read: Read file contents',
  '- bash: Execute bash commands',
  '- edit: Make surgical edits to files',
  '- write: Create or overwrite files',
  '',
  'Guidelines:',
  '- Use bash for file operations like ls, rg, find',
  '- Use read to examine files before editing',
  '- Be concise in your responses',
  '',
  'Current date: 2026-09-23',
  'Current working directory: /workdir',
].join('\n');

function rig() {
  const handlers = new Map<string, AnyHandler[]>();
  let activeTools: string[] = [];
  const registered = new Map<string, ToolDefinition>();
  const pi = {
    on: (event: string, h: AnyHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    registerTool: (def: ToolDefinition) => {
      registered.set(def.name, def);
    },
    registerCommand: () => {},
    getAllTools: (): ToolInfo[] =>
      [...ALL_TOOLS, ...registered.keys()].map((name) => ({
        name,
        description: `${name} tool`,
        // biome-ignore lint/suspicious/noExplicitAny: stub schema.
        parameters: {} as any,
        sourceInfo: {
          path: `<t:${name}>`,
          source: 'builtin',
          scope: 'temporary',
          origin: 'top-level',
        },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    appendEntry: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    cwd: '/workdir',
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
      setStatus: vi.fn(),
      input: async () => 'allow',
    },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    sessionManager: { getEntries: () => [] },
    abort: vi.fn(),
  } as unknown as ExtensionContext & ExtensionCommandContext;
  wireHarness(pi);
  /*
   * The extensions pi loads AFTER the harness (web-tools, browser-use, the mac
   * packages, gen-tools, mcp-lite) register through the harness's capture —
   * which is what puts their groups in the CLI command list. Stand them in.
   */
  for (const name of ALL_TOOLS) {
    if (PI_TOOLS.includes(name) || registered.has(name)) continue;
    pi.registerTool({
      name,
      label: name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [], details: undefined }),
    } as unknown as ToolDefinition);
  }
  const fire = (event: string, e: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx)));
  return { fire, registered, activeTools: () => activeTools };
}

/** Everything the model is sent for one fresh chat's first turn. */
async function surface(mode: '0' | '1') {
  process.env.PI_DESKTOP_TOOL_CLI = mode;
  const r = rig();
  await r.fire('session_start', { type: 'session_start', reason: 'startup' });
  const results = await r.fire('before_agent_start', {
    type: 'before_agent_start',
    prompt: 'hello',
    systemPrompt: BASE_PROMPT,
    images: [],
  });
  const systemPrompt = results
    .map((x) => (x as { systemPrompt?: string } | undefined)?.systemPrompt)
    .find((s) => typeof s === 'string');
  const tools = [...r.registered.values()]
    .map((t) => ({
      name: t.name,
      description: t.description,
      promptSnippet: (t as { promptSnippet?: string }).promptSnippet,
      parameters: JSON.stringify(t.parameters),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { systemPrompt, advertised: r.activeTools(), tools };
}

const OLD_CLI = process.env.PI_DESKTOP_TOOL_CLI;
afterEach(() => {
  if (OLD_CLI === undefined) delete process.env.PI_DESKTOP_TOOL_CLI;
  else process.env.PI_DESKTOP_TOOL_CLI = OLD_CLI;
});

describe('the canonical prompt and tool surface (byte-identical snapshot)', () => {
  it('schemas mode', async () => {
    const s = await surface('0');
    expect(typeof s.systemPrompt).toBe('string');
    await expect(`${JSON.stringify(s, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/canonical-surface.schemas.json.snap',
    );
  });

  it('bash-CLI mode', async () => {
    const s = await surface('1');
    expect(typeof s.systemPrompt).toBe('string');
    await expect(`${JSON.stringify(s, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/canonical-surface.cli.json.snap',
    );
  });

  it('the capability texts: the list, the menu, every activation, every lookup', async () => {
    const texts = {
      capabilities: CAPABILITIES,
      menu: capabilityMenu(),
      activated: CAPABILITIES.map((c) => ({
        name: c.name,
        schemas: capabilityActivated(c, ALL_TOOLS),
        cli: capabilityActivated(c, ALL_TOOLS, c.name),
        none: capabilityActivated(c, []),
      })),
      byTool: Object.fromEntries(ALL_TOOLS.map((t) => [t, capabilityForTool(t)?.name ?? null])),
      lookups: Object.fromEntries(
        ['computer use', 'computer_use', 'mail', 'web', '3D', 'Chrome', 'nothing-like-it'].map(
          (q) => [q, findCapability(q)?.name ?? null],
        ),
      ),
      cliGroups: toolCliGroups(),
    };
    await expect(`${JSON.stringify(texts, null, 1)}\n`).toMatchFileSnapshot(
      './__snapshots__/capability-texts.json.snap',
    );
  });
});
