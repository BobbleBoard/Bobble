import { describe, expect, it, vi } from 'vitest';
import type { CallModelRequest } from './call-model.js';
import { warmSystemPrompt } from './warmup.js';

describe('warmSystemPrompt', () => {
  it('fires a 1-token completion carrying the system prompt, rendered as the chat renders', async () => {
    const seen: CallModelRequest[] = [];
    const callModel = vi.fn(async (req: CallModelRequest) => {
      seen.push(req);
      return 'ok';
    });
    const ok = await warmSystemPrompt(callModel, 'You are a local agent.');
    expect(ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    const req = seen[0];
    expect(req?.system).toBe('You are a local agent.');
    expect(req?.maxTokens).toBe(1);
    expect(req?.temperature).toBe(0);
    // No thinking switch of its own: a template whose system turn reads it
    // (froggeric's Qwen, Gemma 4) would warm a prefix the chat never sends.
    expect(req?.extraBody).toBeUndefined();
  });

  it('carries the initial tool set so the warmed prefix matches a real turn', async () => {
    const seen: CallModelRequest[] = [];
    const callModel = vi.fn(async (req: CallModelRequest) => {
      seen.push(req);
      return 'ok';
    });
    const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }];
    await warmSystemPrompt(callModel, 'You are a local agent.', { tools });
    expect(seen[0]?.tools).toEqual(tools);
  });

  it('skips an empty / whitespace system prompt without calling the model', async () => {
    const callModel = vi.fn(async () => 'x');
    expect(await warmSystemPrompt(callModel, '')).toBe(false);
    expect(await warmSystemPrompt(callModel, '   \n ')).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('swallows a failing endpoint (server not ready) and returns false', async () => {
    const callModel = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(warmSystemPrompt(callModel, 'sys')).resolves.toBe(false);
  });
});
