import { describe, expect, it } from 'vitest';
import { PROMOTE_STATUS_KEY, parsePromoteSignal, showProcessing } from './harness-status';

describe('parsePromoteSignal (corp-promote intent from normal chat)', () => {
  it('parses a valid promote signal', () => {
    const raw = JSON.stringify({
      id: 'promote-1',
      reason: 'a large multi-part build',
      divisions: [{ name: 'Frontend', purpose: 'the UI' }],
    });
    const s = parsePromoteSignal(raw);
    expect(s?.id).toBe('promote-1');
    expect(s?.reason).toBe('a large multi-part build');
    expect(s?.divisions).toHaveLength(1);
  });

  it('returns null for absent / empty / garbage / id-less payloads', () => {
    expect(parsePromoteSignal(undefined)).toBeNull();
    expect(parsePromoteSignal('')).toBeNull();
    expect(parsePromoteSignal('{ not json')).toBeNull();
    // Missing the required id → not a real signal (guards against a stray publish).
    expect(parsePromoteSignal(JSON.stringify({ reason: 'x', divisions: [] }))).toBeNull();
  });

  it('mirrors the harness status key exactly', () => {
    expect(PROMOTE_STATUS_KEY).toBe('harness-promote');
  });
});

describe('showProcessing — the ring on an empty thread', () => {
  /*
   * MEASURED: the user opened Bobble, clicked around, and got "processing · 7.2s"
   * on an empty thread, permanently, having sent nothing. The model warm-up on
   * model_select raises `promptInFlight` and produces neither agent_start nor
   * agent_end, so the flag that normally clears it never came down.
   */
  const base = {
    hasUserMessage: true,
    promptInFlight: false,
    hasStreamingAssistant: false,
    turnHasContent: false,
  };

  it('stays OFF on a fresh chat even with the flag stuck raised', () => {
    expect(showProcessing({ ...base, hasUserMessage: false, promptInFlight: true })).toBe(false);
  });

  it('stays OFF on a fresh chat even if a stream is somehow reported', () => {
    expect(showProcessing({ ...base, hasUserMessage: false, hasStreamingAssistant: true })).toBe(
      false,
    );
  });

  it('shows while a real send is dispatching', () => {
    expect(showProcessing({ ...base, promptInFlight: true })).toBe(true);
  });

  it('shows during the initial prefill of a real turn', () => {
    expect(showProcessing({ ...base, hasStreamingAssistant: true })).toBe(true);
  });

  it('clears the moment the turn produces content', () => {
    expect(showProcessing({ ...base, hasStreamingAssistant: true, turnHasContent: true })).toBe(
      false,
    );
  });

  it('is off when nothing at all is happening', () => {
    expect(showProcessing(base)).toBe(false);
  });
});
