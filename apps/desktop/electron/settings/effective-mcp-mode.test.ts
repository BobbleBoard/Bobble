import { describe, expect, it } from 'vitest';
import { effectiveMcpMode } from './settings-main';

describe('effectiveMcpMode', () => {
  it('translates connectors when the interface is commands', () => {
    // The model is told "these commands are your abilities" and handed a shim
    // per capability; giving it MCP as a structured tool call in the same breath
    // is the contradiction that makes it ignore the commands entirely.
    expect(effectiveMcpMode('lite', 'bash-cli')).toBe('bash-cli');
  });

  it('leaves the schema interface on the proxy', () => {
    expect(effectiveMcpMode('lite', 'schemas')).toBe('lite');
  });

  it('never overrides an explicit choice', () => {
    // `native` registers every connector tool individually — a deliberate
    // decision, and not what this is about.
    expect(effectiveMcpMode('native', 'bash-cli')).toBe('native');
    expect(effectiveMcpMode('bash-cli', 'schemas')).toBe('bash-cli');
  });
});
