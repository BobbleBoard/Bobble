import { PREFIX_WARM_STATUS as HARNESS_PREFIX_WARM_STATUS } from '@pi-desktop/harness';
import { describe, expect, it } from 'vitest';
import {
  modelReadyStage,
  PREFIX_WARM_STATUS,
  PROMOTE_STATUS_KEY,
  parsePrefillPercent,
  parsePromoteSignal,
  showLoadingModel,
  showProcessing,
  threadStatusView,
} from './harness-status';

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

describe('the prefix-warm status key', () => {
  /*
   * THE TWO SIDES MUST AGREE ON THE STRING. The harness publishes this from
   * another process and the renderer watches for it; a typo on either side does
   * not fail — it just never fires, which looks precisely like a warm-up that
   * never finished, i.e. "Loading model" forever over a perfectly good server.
   * Cheap to pin, expensive to debug.
   */
  it('is byte-identical to the constant the harness publishes', () => {
    expect(PREFIX_WARM_STATUS).toBe(HARNESS_PREFIX_WARM_STATUS);
  });

  it('is namespaced `harness-` so a session switch drops it with the rest', () => {
    // pi-slice's setMessagesExternal clears harness-prefixed keys; a key outside
    // that namespace would survive a chat switch and gate the label on a stale
    // warm-up from a different session.
    expect(PREFIX_WARM_STATUS.startsWith('harness-')).toBe(true);
  });
});

describe('showLoadingModel — the label waits for the prefix, not just the server', () => {
  it('shows while the server is still coming up', () => {
    expect(showLoadingModel('starting', undefined)).toBe(true);
    expect(showLoadingModel('starting', 'warming')).toBe(true);
  });

  /*
   * THE BUG. `phase = 'ready'` fires when llama-server answers — seconds before
   * the system prompt is resident — so the label cleared while a first message
   * still paid the full ~2s prefill.
   */
  it('KEEPS showing when the server is up but the prefix is not yet warm', () => {
    expect(showLoadingModel('ready', 'warming')).toBe(true);
  });

  it('clears the instant the prefix is resident — the promise the label makes', () => {
    expect(showLoadingModel('ready', 'ready')).toBe(false);
  });

  it('does NOT wait on a signal that is never coming', () => {
    // No harness warm-up in this build → key never published → behave as before,
    // rather than sitting on "Loading model" over a perfectly usable server.
    expect(showLoadingModel('ready', undefined)).toBe(false);
  });

  it('never shows for a phase that is neither starting nor ready', () => {
    for (const phase of ['idle', 'downloading', 'error']) {
      expect(showLoadingModel(phase, 'warming')).toBe(false);
      expect(showLoadingModel(phase, undefined)).toBe(false);
    }
  });
});

describe('modelReadyStage', () => {
  /*
   * The two waits are different things and used to share a label. MEASURED on a
   * cold start: the model was ready at 6.4s and the screen read "loading model ·
   * 18.6s" while it was already generating.
   */
  it('says LOADING only while the server is still coming up', () => {
    expect(modelReadyStage('starting', undefined)).toBe('loading');
    expect(modelReadyStage('starting', 'warming')).toBe('loading');
  });

  it('says PREPARING once the model is up and the prompt is being read', () => {
    expect(modelReadyStage('ready', 'warming')).toBe('preparing');
  });

  it('says nothing once the prefix is resident — the promise is "a message is instant now"', () => {
    expect(modelReadyStage('ready', 'ready')).toBeNull();
    expect(modelReadyStage('ready', undefined)).toBeNull();
  });

  it('keeps the old boolean meaning for callers that only ask "not ready yet"', () => {
    expect(showLoadingModel('starting', undefined)).toBe(true);
    expect(showLoadingModel('ready', 'warming')).toBe(true);
    expect(showLoadingModel('ready', undefined)).toBe(false);
  });
});

describe('a prefill caused by a capability loading', () => {
  /*
   * Turning a capability on appends tool schemas, and those render at the FRONT
   * of the prompt — so the request right after re-ingests the whole
   * conversation. That is a long wait with a real cause, and "Reading your
   * conversation" is actively wrong about it.
   *
   * the user: "when there's a long prefill because a capability is being loaded
   * instead of 'processing' on that turn make the prefill circle show 'loading
   * <capability>' with of course the color and icon if applicable."
   */
  const base = {
    isStreaming: false,
    retry: null,
    stage: null,
    toolRunning: false,
    isAuto: true,
    switchingToTier: null,
    promptProgress: 42,
  } as const;

  it('names the capability instead of the mechanism', () => {
    const v = threadStatusView({ ...base, loadingCapability: 'computer-use' });
    expect(v?.label).toBe('Loading computer use');
    expect(v?.detail).toBe('42%');
    expect(v?.capability).toBe('computer-use');
  });

  it('says it the way a person would, not the slug', () => {
    expect(threadStatusView({ ...base, loadingCapability: 'web-research' })?.label).toBe(
      'Loading web research',
    );
    expect(threadStatusView({ ...base, loadingCapability: 'personal' })?.label).toBe(
      'Loading your calendar & mail',
    );
  });

  it('falls back to the raw name for a capability it has no phrasing for', () => {
    const v = threadStatusView({ ...base, loadingCapability: 'something-new' });
    expect(v?.label).toBe('Loading something-new');
  });

  it('is the ordinary processing view when no capability is loading', () => {
    expect(threadStatusView({ ...base, loadingCapability: null })?.label).toBe('Processing');
    expect(threadStatusView(base)?.label).toBe('Processing');
  });

  it('does not claim a capability wait when nothing is prefilling', () => {
    // The activation outlives the re-prefill it caused; only the prefill window
    // should wear its name.
    const v = threadStatusView({
      ...base,
      promptProgress: null,
      isStreaming: true,
      loadingCapability: 'browser',
    });
    expect(v?.label).not.toContain('Loading');
  });
});

describe('the prefill channel clears when the ingest ends', () => {
  /*
   * `harness-prefill` was only ever SET, capped at 99 because "the renderer
   * drives the final 100" — and nothing ever wrote that 100. The channel kept
   * its last value for the life of the session, so a reader sees a turn that has
   * been ingesting ever since it finished, and the NEXT turn opens showing the
   * PREVIOUS turn's percentage until a real progress frame replaces it.
   *
   * Found by instrumenting it for the user's ask ("check that prefill makes sense on
   * each turn"): a demo run measured "1 ingest, 252.1s", which was the whole run
   * rather than any ingest. The harness now clears it at both turn boundaries;
   * these pin the reader's half of the contract.
   */
  it('reads an empty channel as no ingest', () => {
    expect(parsePrefillPercent('')).toBeNull();
    expect(parsePrefillPercent(undefined)).toBeNull();
  });

  it('reads a real percentage as an ingest in progress', () => {
    expect(parsePrefillPercent('0')).toBe(0);
    expect(parsePrefillPercent('87')).toBe(87);
  });

  it('treats a completed ingest as no ingest', () => {
    expect(parsePrefillPercent('100')).toBeNull();
  });
});
