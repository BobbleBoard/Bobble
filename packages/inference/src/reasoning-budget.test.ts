import { describe, expect, it } from 'vitest';
import {
  autoThinkingBudget,
  REASONING_BUDGET_MESSAGE,
  THINKING_BUDGET_CEILING,
  THINKING_BUDGET_FLOOR,
  thinkingEndMessage,
} from './reasoning-budget.js';

describe('the thinking-end message', () => {
  it('starts on a fresh paragraph, because llama.cpp splices it in mid-word', () => {
    expect(REASONING_BUDGET_MESSAGE.startsWith('\n\n')).toBe(true);
  });

  it('decides to act and does not invite more thinking', () => {
    expect(REASONING_BUDGET_MESSAGE).toMatch(/stop here and act/);
    expect(REASONING_BUDGET_MESSAGE).not.toMatch(/keep thinking/i);
  });

  it('is never empty: a blank custom message falls back to ours', () => {
    expect(thinkingEndMessage('')).toBe(REASONING_BUDGET_MESSAGE);
    expect(thinkingEndMessage('   ')).toBe(REASONING_BUDGET_MESSAGE);
    expect(thinkingEndMessage(undefined)).toBe(REASONING_BUDGET_MESSAGE);
    expect(thinkingEndMessage('Time to act.')).toBe('\n\nTime to act.\n');
  });
});

describe('autoThinkingBudget', () => {
  it('leaves the reply room under a 32k window with a 10k-token prompt', () => {
    // 30k chars ≈ 10k tokens at the cautious 3 chars/token
    const b = autoThinkingBudget({ contextWindow: 32_768, maxTokens: 28_672, promptChars: 30_000 });
    const room = 32_768 - 10_000;
    expect(b).toBeLessThan(room - 1536);
    expect(b).toBeGreaterThan(10_000);
  });

  it('never passes the ceiling, however big the window', () => {
    expect(autoThinkingBudget({ contextWindow: 262_144, promptChars: 1_000 })).toBe(
      THINKING_BUDGET_CEILING,
    );
  });

  it('honours a small output cap: thinking plus reply fit inside max_tokens', () => {
    const b = autoThinkingBudget({ contextWindow: 32_768, maxTokens: 6_000, promptChars: 3_000 });
    expect(b).toBe(6_000 - 1_800);
  });

  it('keeps a floor when the window is nearly full', () => {
    expect(autoThinkingBudget({ contextWindow: 8_192, promptChars: 24_000 })).toBe(
      THINKING_BUDGET_FLOOR,
    );
  });
});
