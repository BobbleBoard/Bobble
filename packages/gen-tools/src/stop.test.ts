/**
 * STOP ENDS A GENERATION'S TURN — at once (review of the 2026-09-23 wave).
 *
 * pi acknowledges an abort only once its turn has ended, and its agent loop
 * awaits a tool's `execute` without racing the abort signal: a tool that ignores
 * the signal holds the whole turn until its job is done — up to the bridge's
 * 15-minute clock, or the module gate's four minutes. So every tool here must
 * hand the signal to the bridge, and the bridge must give up the moment it
 * fires and tell the app (which then cancels the job — nobody is left to
 * receive it).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { type GenBridge, GenBridgeClient } from './gen-bridge-client.ts';
import type { GenBridgeMethod, GenBridgeRequest } from './gen-contract.ts';
import {
  GENERATE_IMAGE_TOOL,
  GENERATE_MUSIC_TOOL,
  GENERATE_SPEECH_TOOL,
  GENERATE_SVG_TOOL,
  GENERATE_VIDEO_TOOL,
  registerAudioTools,
  registerGenTools,
} from './tools.ts';

/** A bridge whose job never finishes, and which gives up when told — the real
 * client's contract (tested against a real socket below). */
class StuckBridge implements GenBridge {
  readonly asked: Array<{ method: GenBridgeMethod; signal: AbortSignal | undefined }> = [];
  request<T>(
    method: GenBridgeMethod,
    _params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.asked.push({ method, signal });
    return new Promise<T>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  }
}

function tools(bridge: GenBridge): Map<string, ToolDefinition> {
  const out = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => out.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerGenTools(pi, { bridge, svg: true });
  registerAudioTools(pi, { bridge });
  return out;
}

/** Run a tool, press Stop once it is waiting, and say whether it came back. */
async function stopDuring(name: string, params: Record<string, unknown>) {
  const bridge = new StuckBridge();
  const tool = tools(bridge).get(name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  const turn = new AbortController();
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  const running = tool.execute('call-1', params as any, turn.signal, undefined, {} as any);
  await new Promise((r) => setTimeout(r, 0));
  turn.abort();
  const settled = await Promise.race([
    running.then((result) => ({ result })),
    new Promise<null>((r) => setTimeout(() => r(null), 200)),
  ]);
  return { bridge, settled };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('');

describe('Stop during a generation', () => {
  it.each([
    [GENERATE_IMAGE_TOOL, { prompt: 'a red fox' }],
    [GENERATE_VIDEO_TOOL, { prompt: 'a breaking wave' }],
    [GENERATE_SPEECH_TOOL, { prompt: 'hello there' }],
    [GENERATE_MUSIC_TOOL, { prompt: 'a slow piano waltz' }],
    [GENERATE_SVG_TOOL, { prompt: 'a lighthouse' }],
  ])('%s gives the bridge the turn’s signal and returns the moment it fires', async (name, params) => {
    const { bridge, settled } = await stopDuring(name, params);
    expect(bridge.asked[0]?.signal).toBeDefined();
    expect(settled).not.toBeNull();
    expect(textOf(settled?.result as never)).toMatch(/stopped/i);
  });
});

describe('GenBridgeClient — a request the turn stopped', () => {
  const servers: net.Server[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An app that takes every request and never answers. */
  function silentApp(): Promise<{ socketPath: string; received: GenBridgeRequest[] }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-gen-stop-'));
    dirs.push(dir);
    const socketPath = path.join(dir, 's.sock');
    const received: GenBridgeRequest[] = [];
    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim() !== '') received.push(JSON.parse(line) as GenBridgeRequest);
          nl = buf.indexOf('\n');
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(socketPath, () => resolve({ socketPath, received })),
    );
  }

  it('rejects at once and tells the app to let the job go', async () => {
    const app = await silentApp();
    const client = new GenBridgeClient({ socketPath: app.socketPath, token: 't' });
    const turn = new AbortController();
    const asked = client.request('generate', { prompt: 'a fox' }, turn.signal);
    asked.catch(() => undefined);
    await expect.poll(() => app.received.length).toBe(1);
    turn.abort();
    const outcome = await Promise.race([
      asked.then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
      new Promise<string>((r) => setTimeout(() => r('still waiting'), 200)),
    ]);
    expect(outcome).toMatch(/stopped/i);
    const generate = app.received[0];
    await expect.poll(() => app.received.length).toBe(2);
    expect(app.received[1]).toMatchObject({
      method: 'abandon',
      token: 't',
      params: { requestId: generate?.id },
    });
    client.dispose();
  });

  it('a signal already fired asks for nothing', async () => {
    const app = await silentApp();
    const client = new GenBridgeClient({ socketPath: app.socketPath, token: 't' });
    const turn = new AbortController();
    turn.abort();
    await expect(client.request('generate', { prompt: 'x' }, turn.signal)).rejects.toThrow(
      /stopped/i,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(app.received).toEqual([]);
    client.dispose();
  });
});
