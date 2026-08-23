/**
 * The engine catalog decides what a user is ALLOWED to install, so the tests
 * that matter are the ones about refusing: an engine offered on a machine that
 * cannot run it wastes a download and ends in a failure the user can't explain.
 */
import { describe, expect, it } from 'vitest';
import {
  baselineEngine,
  ENGINES,
  type EngineSpec,
  engineSupport,
  enginesFor,
  formatEngineSize,
  type HostCapabilities,
  installPrerequisites,
  orderEnginesForDisplay,
  preferredEngine,
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

/**
 * THE PORTABILITY MATRIX. the user, correcting a Mac-shaped answer: "we target all
 * major OS and all major hardware eventually in a modular fashion such that we
 * have a boatload of alternatives that we know of and can get working quick to
 * get max out of the box no setup fast inference for any hardware on any OS."
 *
 * These are the invariants that keep that true as engines are added — the ones a
 * plausible next commit could break without anyone noticing on a Mac.
 */
describe('engines per (platform, modality)', () => {
  const mac: HostCapabilities = { platform: 'darwin', appleSilicon: true };
  const intelMac: HostCapabilities = { platform: 'darwin', appleSilicon: false };
  const win: HostCapabilities = { platform: 'win32', appleSilicon: false };
  const linux: HostCapabilities = { platform: 'linux', appleSilicon: false };

  it('gives EVERY platform a text engine and an image engine', () => {
    // The whole promise: no host is left with a modality it cannot do at all.
    for (const host of [mac, intelMac, win, linux]) {
      expect(enginesFor('text', host).length, `text on ${host.platform}`).toBeGreaterThan(0);
      expect(enginesFor('image', host).length, `image on ${host.platform}`).toBeGreaterThan(0);
      expect(enginesFor('video', host).length, `video on ${host.platform}`).toBeGreaterThan(0);
    }
  });

  it('keeps a BASELINE for every modality on every platform', () => {
    // A fast path is an optimisation over something that already works. If the
    // only engine for a modality is a fast path, the modality is unsupported on
    // every machine that path was not written for.
    for (const host of [mac, intelMac, win, linux]) {
      for (const modality of ['text', 'image', 'video'] as const) {
        expect(baselineEngine(modality, host), `${modality} on ${host.platform}`).toBeDefined();
      }
    }
  });

  it('does not offer an Apple-Silicon engine to an Intel Mac', () => {
    // Same platform string, different hardware — the case that a `platforms`
    // check alone gets wrong.
    expect(enginesFor('text', intelMac).map((e) => e.id)).not.toContain('rapid-mlx');
    expect(enginesFor('text', mac).map((e) => e.id)).toContain('rapid-mlx');
  });

  it('prefers the fast path where one exists and the baseline where none does', () => {
    expect(preferredEngine('text', mac)?.id).toBe('dflash-mlx');
    // Nothing beats the portable one for images anywhere yet — which is a fact
    // about our engine list, not about the hardware.
    expect(preferredEngine('image', mac)?.id).toBe('comfyui');
    expect(preferredEngine('image', win)?.id).toBe('comfyui');
  });

  it('never lets a specialist be the only answer for a modality', () => {
    for (const host of [mac, intelMac, win, linux]) {
      for (const modality of ['text', 'image', 'video', 'audio'] as const) {
        const list = enginesFor(modality, host);
        if (list.length === 0) continue;
        expect(
          list.some((e) => e.baseline === true),
          `${modality} on ${host.platform}`,
        ).toBe(true);
      }
    }
  });
});
