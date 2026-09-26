/**
 * THE STALL, OVER A REAL SOCKET.
 *
 * The fake-clock tests prove the rules; this one proves the plumbing they rely
 * on: that undici's fetch, aborted mid-body, really breaks the provider's read
 * loop, that the server really sees the connection close (rapid-mlx's
 * disconnect guard aborts the request in its scheduler on exactly that), and
 * that nothing else — no process, no second socket — is touched. A local
 * `node:http` server plays rapid-mlx: role chunk, a short thought, the "\n\n"
 * after `</think>`, then `: keepalive` comments forever, with `/v1/status`
 * frozen. Real timers, windows shrunk through the env knobs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLlamaCppStream } from './stream.js';

interface ChatRecord {
  closedByClient: boolean;
  endedByServer: boolean;
}

describe('stall watchdog over HTTP (real fetch, real server, real timers)', () => {
  const chats: ChatRecord[] = [];
  let statusCalls = 0;
  let behaviour: 'stall-then-answer' | 'always-stall' = 'stall-then-answer';
  let base = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/slots') {
      statusCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 0, is_processing: true, next_token: { n_decoded: 143 } }]));
      return;
    }
    req.resume();
    const record: ChatRecord = { closedByClient: false, endedByServer: false };
    chats.push(record);
    const n = chats.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
    if (behaviour === 'stall-then-answer' && n === 2) {
      send({ choices: [{ delta: { reasoning_content: 'Second try.' } }] });
      send({ choices: [{ delta: { content: 'Answer.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      record.endedByServer = true;
      return;
    }
    send({ choices: [{ delta: { reasoning_content: 'The user wants an animation.' } }] });
    send({ choices: [{ delta: { content: '\n\n' } }] });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 200);
    res.on('close', () => {
      clearInterval(keepalive);
      if (!record.endedByServer) record.closedByClient = true;
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv('PI_STREAM_STALL_MS', '1500');
    vi.stubEnv('PI_STREAM_STALL_PROBE_AFTER_MS', '300');
    vi.stubEnv('PI_STREAM_STALL_PROBE_EVERY_MS', '300');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const model = (): Model<'openai-completions'> => ({
    id: 'qwen3.5-4b',
    name: 'Qwen',
    api: 'openai-completions',
    provider: 'llamacpp',
    baseUrl: `${base}/v1`,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  });
  const ctx: Context = {
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'explain projectile motion', timestamp: 0 }],
  };
  const drain = async (s: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> => {
    for await (const e of s) {
      if (e.type === 'done') return e.message;
      if (e.type === 'error') return e.error;
    }
    throw new Error('stream never terminated');
  };

  it('cancels the silent request (the server sees the socket close) and the retry answers', async () => {
    chats.length = 0;
    behaviour = 'stall-then-answer';
    const t0 = Date.now();
    const final = await drain(createLlamaCppStream({ serverReturnWaitMs: 0 })(model(), ctx));
    const elapsed = Date.now() - t0;
    expect(final.stopReason).toBe('stop');
    expect(final.content).toEqual([
      { type: 'thinking', thinking: 'Second try.' },
      { type: 'text', text: 'Answer.' },
    ]);
    expect(chats).toHaveLength(2);
    await vi.waitFor(() => expect(chats[0]?.closedByClient).toBe(true));
    expect(chats[1]?.endedByServer).toBe(true);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    // ~1.5 s of keepalives then the retry — not the 300 s the suite sat through.
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(6000);
  });

  it('a retry that stalls too ends the turn with the plain error, both sockets closed', async () => {
    chats.length = 0;
    behaviour = 'always-stall';
    const final = await drain(createLlamaCppStream({ serverReturnWaitMs: 0 })(model(), ctx));
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toMatch(/^The model stopped responding: no output for 2 s/);
    expect(chats).toHaveLength(2);
    await vi.waitFor(() => expect(chats.every((c) => c.closedByClient)).toBe(true));
  });
});
