import { describe, expect, it } from 'vitest';
import { DEVICES_INVOKE_CHANNELS } from './devices/devices-contract';
import { EDITOR_INVOKE_CHANNELS } from './editor/editor-contract';
import { HELP_INVOKE_CHANNELS } from './help/help-contract';
import { APP_INVOKE_CHANNELS } from './ipc-contract';
import { MEMORY_INVOKE_CHANNELS } from './memory/memory-contract';
import { TRAINING_INVOKE_CHANNELS } from './training/training-contract';
import { WORKFLOWS_INVOKE_CHANNELS } from './workflows/workflows-contract';

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

/*
 * The W0-A pre-wire composed six feature contracts in before their lanes
 * existed (PLAN.md §2.3), so each lane grows its own contract file and never
 * this one. These hold that composition and the one rule a lane could get
 * wrong without a compile error: a feature's channels live in its own domain.
 */
describe('the pre-wired feature contracts', () => {
  const features: Array<[string, readonly string[], readonly string[]]> = [
    ['memory', MEMORY_INVOKE_CHANNELS, ['memory']],
    ['help', HELP_INVOKE_CHANNELS, ['help']],
    ['training', TRAINING_INVOKE_CHANNELS, ['train', 'datasets']],
    ['devices', DEVICES_INVOKE_CHANNELS, ['devices']],
    ['editor', EDITOR_INVOKE_CHANNELS, ['editor']],
    ['workflows', WORKFLOWS_INVOKE_CHANNELS, ['workflows']],
  ];

  it.each(features)('%s: every channel reaches the preload allowlist', (_name, channels) => {
    const all = new Set<string>(APP_INVOKE_CHANNELS);
    for (const c of channels) expect(all.has(c)).toBe(true);
  });

  it.each(features)('%s: channels stay in their own domain', (_name, channels, domains) => {
    for (const c of channels) expect(domains).toContain(c.split(':')[0]);
  });
});
