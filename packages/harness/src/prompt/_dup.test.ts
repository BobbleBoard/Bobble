import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { augmentSystemPrompt, CAPABILITY_PROMPT_MARKER } from './capability-prompt';

describe('idempotence', () => {
  it('does not append the section twice', () => {
    const o = { toolInterface: 'bash-cli' as const };
    const once = augmentSystemPrompt('base', o);
    const twice = augmentSystemPrompt(once, o);
    const count = (s: string) => s.split(CAPABILITY_PROMPT_MARKER).length - 1;
    writeFileSync('/tmp/dup.txt', `once=${count(once)} twice=${count(twice)}`);
    expect(count(twice)).toBe(1);
  });
});
