import { describe, expect, it } from 'vitest';
import { APP_INVOKE_CHANNELS } from './ipc-contract';

// Exhaustiveness (every AppInvokeMap channel is listed) is a compile-time
// assertion in ipc-contract.ts; these guard the runtime shape the preload
// allowlist is built from.
describe('APP_INVOKE_CHANNELS', () => {
  it('contains no duplicates', () => {
    expect(new Set(APP_INVOKE_CHANNELS).size).toBe(APP_INVOKE_CHANNELS.length);
  });

  it('uses domain:action kebab-case names only', () => {
    for (const channel of APP_INVOKE_CHANNELS) {
      // The domain may carry digits (`gen3d:`), the action stays kebab-case.
      //
      // ONE optional sub-domain is allowed (`mac:monitor:subscribe`). A domain
      // that grows a second, separately-owned feature — mac computer-use has
      // the agent bridge AND the window monitor — either namespaces it or
      // starts inventing prefixes like `macmonitor:`, which is the same
      // structure with the boundary hidden. The shape is still strict: exactly
      // one extra segment, same character rules, and the last segment is still
      // the action.
      expect(channel).toMatch(/^[a-z][a-z0-9]*(:[a-z][a-z0-9]*)?:[a-z]+(-[a-z]+)*$/);
    }
  });
});
