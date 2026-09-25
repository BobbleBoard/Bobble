/**
 * STOP REACHES A CEO WAITING ON ITS TEAM (review of the 2026-09-23 wave).
 *
 * `talk_to_manager` blocks until the team delivers, for tens of minutes to
 * hours, and pi's agent loop awaits a tool without racing the abort: a CEO
 * whose tool ignored the signal held a Stop for the whole production. The
 * composer's own Stop reaches the team only while the store still points at
 * it, and a chat switch drops that pointer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorpRunResult, corpBridgeRunFromEnv } from './bridge-client.js';
import { type PromoteToolDeps, registerCreateHierarchyTool } from './promote-tool.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal structural tool capture for tests
type CapturedTool = any;

function register(runCorp: PromoteToolDeps['runCorp']): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: CapturedTool) => tools.push(t) } as unknown as ExtensionAPI;
  registerCreateHierarchyTool(pi, {
    getEffort: () => 'max',
    nextId: () => 'fixed-id',
    runCorp,
    otherToolCalls: () => 5,
  });
  return tools[0];
}

const ctx = { hasUI: true, ui: { setStatus: () => undefined } } as never;
const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => c.text ?? '').join('');

describe('talk_to_manager and Stop', () => {
  it('hands the turn’s signal to the team and returns the moment it fires', async () => {
    let seen: AbortSignal | undefined;
    // The real bridge's contract: a production that never delivers, which gives
    // up when told (tested against a real socket below).
    const tool = register((_req, signal) => {
      seen = signal;
      return new Promise<CorpRunResult>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => resolve({ ok: false, product: '', error: 'stopped', stopped: true }),
          { once: true },
        );
      });
    });
    const turn = new AbortController();
    const call = tool.execute('c', { message: 'Build the game' }, turn.signal, undefined, ctx);
    await new Promise((r) => setTimeout(r, 0));
    turn.abort();
    const settled = await Promise.race([
      call,
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);
    expect(seen).toBeDefined();
    expect(settled).not.toBeNull();
    // Not "the production did not complete … tell the user the hand-off failed".
    expect(textOf(settled)).toMatch(/stopped/i);
    expect(textOf(settled)).not.toMatch(/Nothing was delivered/);
  });
});

describe('corp bridge client — the CEO stopped waiting', () => {
  const servers: net.Server[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An app that starts the production and never delivers; records the hang-up. */
  function silentApp(): Promise<{ sock: string; asked: string[]; closed: () => boolean }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-corp-stop-'));
    dirs.push(dir);
    const sock = path.join(dir, 's.sock');
    const asked: string[] = [];
    let closed = false;
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => asked.push(chunk));
      socket.on('close', () => {
        closed = true;
      });
    });
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(sock, () => resolve({ sock, asked, closed: () => closed })),
    );
  }

  it('resolves at once as stopped, and hangs up so the app stops the team', async () => {
    const app = await silentApp();
    const run = corpBridgeRunFromEnv({
      PI_DESKTOP_SUBAGENT_SOCK: app.sock,
      PI_DESKTOP_SUBAGENT_TOKEN: 't',
    });
    if (run === null) throw new Error('expected a bridge');
    const turn = new AbortController();
    const result = run({ message: 'Build the game' }, turn.signal);
    await expect.poll(() => app.asked.length).toBe(1);
    turn.abort();
    const outcome = await Promise.race([
      result,
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);
    expect(outcome).toMatchObject({ ok: false, stopped: true });
    await expect.poll(() => app.closed()).toBe(true);
  });
});
