// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteInputActivity, resetInputActivityThrottle } from './input-activity';

describe('noteInputActivity', () => {
  afterEach(() => resetInputActivityThrottle());

  it('tells main at most every two seconds', () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    (window as unknown as { piDesktop: unknown }).piDesktop = { invoke };
    noteInputActivity(10_000);
    noteInputActivity(10_500);
    noteInputActivity(11_900);
    expect(invoke).toHaveBeenCalledTimes(1);
    noteInputActivity(12_100);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('llm:input-activity', undefined);
  });
});
