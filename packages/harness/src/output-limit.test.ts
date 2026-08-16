/**
 * A turn cut off at the output ceiling did nothing, and nothing noticed.
 *
 * MEASURED, run 16 (Qwen3.8-27B). After twelve sensible environment probes the
 * CEO wrote "Alright, let's write all the application files. I'll write them one
 * by one." and then emitted the whole application as prose: 20,541 output
 * tokens, 28 minutes at ~16 tok/s, straight into the 49,152-token ceiling.
 * `stopReason: 'length'`. No `write` call, no file, run over — the main-chat
 * path had no handling for this at all. The equivalent guard in
 * `corp/role-agent.ts` covers the corp ROLES only.
 */
import { describe, expect, it } from 'vitest';
import { endedAtOutputLimit, OUTPUT_LIMIT_NUDGE } from './index.js';

const assistant = (stopReason?: string) => ({ role: 'assistant', content: 'text', stopReason });

describe('endedAtOutputLimit', () => {
  it('is true when the last assistant turn was cut off at the limit', () => {
    expect(endedAtOutputLimit([assistant('length')])).toBe(true);
  });

  it('is false for a turn that finished on its own terms', () => {
    expect(endedAtOutputLimit([assistant('stop')])).toBe(false);
    expect(endedAtOutputLimit([assistant('toolUse')])).toBe(false);
    expect(endedAtOutputLimit([assistant(undefined)])).toBe(false);
  });

  it('reads the LAST assistant turn, not an earlier one', () => {
    // An earlier truncated turn that was already recovered from must not
    // re-trigger the steer on a later, healthy turn.
    expect(endedAtOutputLimit([assistant('length'), assistant('toolUse')])).toBe(false);
    expect(endedAtOutputLimit([assistant('toolUse'), assistant('length')])).toBe(true);
  });

  it('skips non-assistant messages to find the turn that ended', () => {
    const msgs = [assistant('length'), { role: 'toolResult', content: 'out' }];
    // The tool result is not a turn end; the assistant before it is.
    expect(endedAtOutputLimit(msgs)).toBe(true);
  });

  it('is false for an empty or assistant-free history', () => {
    expect(endedAtOutputLimit([])).toBe(false);
    expect(endedAtOutputLimit([{ role: 'user', content: 'hi' }])).toBe(false);
  });
});

describe('OUTPUT_LIMIT_NUDGE', () => {
  it('says the turn had no effect, which is the fact the model cannot see', () => {
    expect(OUTPUT_LIMIT_NUDGE).toMatch(/cut off/);
    expect(OUTPUT_LIMIT_NUDGE).toMatch(/nothing was saved/);
  });

  it('names the actual mistake — printing a file instead of writing one', () => {
    expect(OUTPUT_LIMIT_NUDGE).toMatch(/a reply is not a file/);
    expect(OUTPUT_LIMIT_NUDGE).toMatch(/`write`/);
    expect(OUTPUT_LIMIT_NUDGE).toMatch(/ONE call per file/);
  });

  /* Telling it to "be shorter" would be the obvious steer and the wrong one:
     the reply length was a symptom of writing into the wrong place. */
  it('does not merely ask for brevity', () => {
    expect(OUTPUT_LIMIT_NUDGE).not.toMatch(/be brief|shorter reply|concise/i);
  });
});
