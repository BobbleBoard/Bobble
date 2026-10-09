import { describe, expect, it } from 'vitest';
import { describeTurnProblem } from './turn-problem';

describe('describeTurnProblem — every error a turn can end in gets a cause and a fix', () => {
  it('shows nothing for no error, or for a turn the person stopped', () => {
    expect(describeTurnProblem(undefined)).toBeNull();
    expect(describeTurnProblem('')).toBeNull();
    expect(describeTurnProblem('This operation was aborted')).toBeNull();
    expect(describeTurnProblem('AbortError: The user aborted a request.')).toBeNull();
  });

  it('a dead engine ("fetch failed") offers to restart it', () => {
    const p = describeTurnProblem('fetch failed');
    expect(p?.kind).toBe('engine-away');
    expect(p?.fix).toBe('restart');
    expect(p?.title).not.toMatch(/fetch/i);
    expect(p?.detail).toBe('fetch failed');
  });

  it('short of memory offers to try again or pick a smaller model', () => {
    const p = describeTurnProblem(
      'The local model could not run ("Compute error.") — it is short of memory. Close other apps or choose a smaller model, then try again.',
    );
    expect(p?.kind).toBe('memory');
    expect(p?.fix).toBe('retry');
    expect(p?.also).toContain('smaller-model');
  });

  it('a chat too long for the model offers a new chat or a model that reads more', () => {
    const p = describeTurnProblem(
      "This conversation is too long for the model's context window, even after trimming older tool output. Start a new chat or switch to a larger-context model.",
    );
    expect(p?.kind).toBe('too-long');
    expect(p?.fix).toBe('new-chat');
    expect(p?.also).toContain('longer-model');
  });

  it('a stall offers to restart the model', () => {
    const p = describeTurnProblem(
      'The model stopped responding: no output for 120s. It was cancelled and sent again, and the new attempt stalled the same way. Switching models or restarting Bobble restarts the model engine.',
    );
    expect(p?.kind).toBe('stalled');
    expect(p?.fix).toBe('restart');
  });

  it('an engine error (HTTP 500, a raw JSON blob) offers to try again, then restart', () => {
    for (const raw of [
      'The local model server returned an error (HTTP 500). Please try again.',
      'llama-server http 500: {"error":{"code":500,"message":"boom"}}',
      'The local model server stopped with an error: slot unavailable. Please try again.',
    ]) {
      const p = describeTurnProblem(raw);
      expect(p?.kind, raw).toBe('engine-error');
      expect(p?.fix).toBe('retry');
      expect(p?.also).toContain('restart');
      expect(p?.title).not.toMatch(/HTTP|500|error":/);
    }
  });

  it('anything else still says what happened and offers to send it again', () => {
    const p = describeTurnProblem('TypeError: Cannot read properties of undefined (reading "x")');
    expect(p?.kind).toBe('unexpected');
    expect(p?.fix).toBe('retry');
    expect(p?.title).not.toMatch(/TypeError|undefined/);
    expect(p?.detail).toMatch(/TypeError/);
  });
});
