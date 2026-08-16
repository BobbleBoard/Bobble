/**
 * The engine catalog decides what a user is ALLOWED to install, so the tests
 * that matter are the ones about refusing: an engine offered on a machine that
 * cannot run it wastes a download and ends in a failure the user can't explain.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINES,
  type EngineSpec,
  engineSupport,
  formatEngineSize,
  type HostCapabilities,
  installPrerequisites,
  orderEnginesForDisplay,
  recommendedEngine,
} from './engine-catalog';

const mac: HostCapabilities = { platform: 'darwin', appleSilicon: true };
const intelMac: HostCapabilities = { platform: 'darwin', appleSilicon: false };
const windows: HostCapabilities = { platform: 'win32', appleSilicon: false };
const linux: HostCapabilities = { platform: 'linux', appleSilicon: false };

const byId = (id: string): EngineSpec => {
  const hit = ENGINES.find((e) => e.id === id);
  if (hit === undefined) throw new Error(`no engine ${id}`);
  return hit;
};

describe('support is a reason, not a boolean', () => {
  it('greys vLLM off macOS and Windows with the real reason', () => {
    // the user's own example: "vllm is linux only so that greyed out on win/mac".
    expect(engineSupport(byId('vllm'), mac)).toEqual({ supported: false, reason: 'Linux only' });
    expect(engineSupport(byId('vllm'), windows)).toEqual({
      supported: false,
      reason: 'Linux only',
    });
    expect(engineSupport(byId('vllm'), linux)).toEqual({ supported: true });
  });

  it('refuses MLX engines on an INTEL Mac, not just off macOS', () => {
    // The trap: platform says darwin, so a naive check offers MLX to an Intel
    // Mac and it fails at run time.
    expect(engineSupport(byId('rapid-mlx'), mac)).toEqual({ supported: true });
    expect(engineSupport(byId('rapid-mlx'), intelMac)).toEqual({
      supported: false,
      reason: 'Needs Apple Silicon',
    });
  });

  it('offers llama.cpp on every host — the portable floor', () => {
    for (const host of [mac, intelMac, windows, linux]) {
      expect(engineSupport(byId('llamacpp'), host).supported).toBe(true);
    }
  });

  it('names both platforms when an engine runs on two', () => {
    expect(engineSupport(byId('lemonade'), mac)).toEqual({
      supported: false,
      reason: 'Windows and Linux only',
    });
  });
});

describe('display order', () => {
  it('puts every unsupported engine last', () => {
    const rows = orderEnginesForDisplay(mac);
    const firstUnsupported = rows.findIndex((r) => !r.support.supported);
    expect(firstUnsupported).toBeGreaterThan(0);
    expect(rows.slice(firstUnsupported).every((r) => !r.support.supported)).toBe(true);
  });

  it('lists every engine exactly once, whatever the host', () => {
    for (const host of [mac, intelMac, windows, linux]) {
      const rows = orderEnginesForDisplay(host);
      expect(rows).toHaveLength(ENGINES.length);
      expect(new Set(rows.map((r) => r.spec.id)).size).toBe(ENGINES.length);
    }
  });
});

describe('what onboarding installs on its own', () => {
  it('never recommends an engine the host cannot run', () => {
    for (const host of [mac, intelMac, windows, linux]) {
      expect(engineSupport(recommendedEngine(host), host).supported).toBe(true);
    }
  });

  it('picks the fast single-chat path on Apple Silicon', () => {
    expect(recommendedEngine(mac).id).toBe('dflash-mlx');
  });

  it('falls back to the portable engine where MLX cannot run', () => {
    expect(recommendedEngine(intelMac).id).toBe('llamacpp');
    expect(recommendedEngine(windows).id).toBe('llamacpp');
  });
});

describe('size chips', () => {
  it('shows GB and MB at sensible precision', () => {
    expect(formatEngineSize(byId('dflash-mlx'))).toBe('1.2 GB');
    expect(formatEngineSize(byId('llamacpp'))).toBe('26 MB');
  });

  it('shows nothing for an engine too small to matter', () => {
    // Rule 2: `undefined` means "don't render a chip", NOT "0 B".
    expect(formatEngineSize({ ...byId('llamacpp'), approxBytes: undefined })).toBeNull();
  });
});

describe('prerequisites', () => {
  it('installs the MLX runtime before the DFlash path that needs it', () => {
    expect(installPrerequisites('dflash-mlx').map((e) => e.id)).toEqual(['rapid-mlx']);
  });

  it('is empty for a standalone engine', () => {
    expect(installPrerequisites('llamacpp')).toEqual([]);
  });

  it('cannot loop on a cyclic catalog', () => {
    const cyclic: EngineSpec[] = [
      { ...byId('llamacpp'), id: 'a', requires: ['b'] },
      { ...byId('llamacpp'), id: 'b', requires: ['a'] },
    ];
    expect(installPrerequisites('a', cyclic).map((e) => e.id)).toEqual(['b']);
  });
});
