/**
 * The onboarding presets as a plan over this machine — see presets.ts. These
 * pin the promises the chooser will make: what each word means in the app's
 * inventory, that nothing is promised the app would refuse to run, and that a
 * small machine gets a valid plan rather than a dropped one.
 */
import { describe, expect, it } from 'vitest';
import {
  formatDownload,
  formatDownloadTime,
  type PresetInventory,
  planPreset,
  suggestedPreset,
} from './presets';

const GB = 1024 ** 3;

/** A 24 GB Mac as the recommender sees it today. */
function mac24(over: Partial<PresetInventory> = {}): PresetInventory {
  return {
    totalMemoryBytes: 24 * GB,
    tiers: {
      fast: {
        modelId: 'qwen3.5-4b-mtp',
        displayName: 'Qwen3.5 4B',
        bytes: 4.6 * GB,
        downloaded: true,
      },
      balanced: {
        modelId: 'qwen3.5-9b-mtp',
        displayName: 'Qwen3.5 9B',
        bytes: 9.8 * GB,
        downloaded: false,
      },
      intelligent: {
        modelId: 'qwen3.6-27b',
        displayName: 'Qwen3.6 27B',
        bytes: 17.1 * GB,
        downloaded: false,
      },
    },
    modules: [
      { id: 'image', label: 'Image module', approxGB: 2, ready: false },
      { id: 'audio', label: 'Audio module', approxGB: 1.5, ready: false },
      { id: 'comfy', label: 'ComfyUI', approxGB: 1.5, ready: false },
      { id: '3d', label: '3D engine', approxGB: 4, ready: false },
      { id: 'weights:trellis2-comfy', label: 'TRELLIS.2 weights', approxGB: 9, ready: false },
    ],
    connectors: [
      { id: 'mac-personal', label: 'Calendar, Mail, Messages…', bytes: 0, installed: true },
      { id: 'omnisvg', label: 'OmniSVG', bytes: 5.1 * GB, installed: false },
    ],
    wiredEngines: ['rapid-mlx', 'omlx'],
    recommendedEngine: 'rapid-mlx',
    ...over,
  };
}

describe('what the three words mean', () => {
  it('minimal is base pi: the recommended engine and the fast model, nothing else', () => {
    const plan = planPreset('minimal', mac24());
    expect(plan.models.map((m) => m.modelId)).toEqual(['qwen3.5-4b-mtp']);
    expect(plan.engines).toEqual(['rapid-mlx']);
    expect(plan.modules).toEqual([]);
    expect(plan.connectors).toEqual([]);
    expect(plan.downloadBytes).toBe(0); // the 4B is already on disk
    expect(formatDownload(plan.downloadBytes)).toBe('nothing to download');
  });

  it('default adds the balanced model, pictures and voices, and the free connectors', () => {
    const plan = planPreset('default', mac24());
    expect(plan.models.map((m) => m.modelId)).toEqual(['qwen3.5-4b-mtp', 'qwen3.5-9b-mtp']);
    expect(plan.modules.map((m) => m.id)).toEqual(['image', 'audio']);
    expect(plan.connectors.map((c) => c.id)).toEqual(['mac-personal']);
    expect(plan.engines).toEqual(['rapid-mlx']);
    // 9.8 GB of model + 3.5 GB of modules; nothing for the free connector.
    expect(Math.round((plan.downloadBytes / GB) * 10) / 10).toBe(13.3);
    expect(formatDownload(plan.downloadBytes)).toBe('about 13 GB');
  });

  it('max reaches for everything — every engine, every module, every connector', () => {
    const plan = planPreset('max', mac24());
    expect(plan.engines).toEqual(['rapid-mlx', 'omlx']);
    expect(plan.modules.map((m) => m.id)).toEqual([
      'image',
      'audio',
      'comfy',
      '3d',
      'weights:trellis2-comfy',
    ]);
    expect(plan.connectors.map((c) => c.id)).toEqual(['mac-personal', 'omnisvg']);
  });
});

describe('nothing is promised that the app would refuse to run', () => {
  it('max on a 24 GB Mac skips the 27B, with the same reason the app gives', () => {
    const plan = planPreset('max', mac24());
    expect(plan.models.map((m) => m.modelId)).toEqual(['qwen3.5-4b-mtp', 'qwen3.5-9b-mtp']);
    const skip = plan.skipped.find((s) => s.id === 'qwen3.6-27b');
    expect(skip?.reason).toMatch(/push the whole system into swap/);
  });

  it('an 8 GB machine gets the 4B, the modules and the connectors — a plan, not a refusal', () => {
    const plan = planPreset('max', mac24({ totalMemoryBytes: 8 * GB }));
    expect(plan.models.map((m) => m.modelId)).toEqual(['qwen3.5-4b-mtp']);
    expect(plan.skipped.map((s) => s.id)).toEqual(['qwen3.5-9b-mtp', 'qwen3.6-27b']);
    expect(plan.modules.length).toBeGreaterThan(0);
  });

  it('two tiers resolving to one checkpoint list it once', () => {
    const inv = mac24();
    const plan = planPreset('default', {
      ...inv,
      tiers: { fast: inv.tiers.fast, balanced: inv.tiers.fast },
    });
    expect(plan.models.map((m) => m.modelId)).toEqual(['qwen3.5-4b-mtp']);
  });

  it('a tier the recommender has not filled in is reported, not crashed on', () => {
    const plan = planPreset('max', mac24({ tiers: {} }));
    expect(plan.models).toEqual([]);
    expect(plan.skipped.map((s) => s.id)).toEqual(['fast', 'balanced', 'intelligent']);
  });

  it('a module the build does not offer is named in the skips', () => {
    const plan = planPreset('default', mac24({ modules: [] }));
    expect(plan.skipped.map((s) => s.id)).toEqual(['image', 'audio']);
  });
});

describe('the size and the time beside each word', () => {
  it('counts only what is not on disk', () => {
    const inv = mac24();
    const plan = planPreset('default', {
      ...inv,
      modules: inv.modules.map((m) => ({ ...m, ready: true })),
      tiers: {
        ...inv.tiers,
        balanced: {
          ...(inv.tiers.balanced as PresetInventory['tiers']['fast'] & object),
          downloaded: true,
        },
      },
    });
    expect(plan.downloadBytes).toBe(0);
  });

  it('formats sizes and a modest-line time estimate', () => {
    expect(formatDownload(0.5 * GB)).toBe('about 500 MB');
    expect(formatDownload(13.3 * GB)).toBe('about 13 GB');
    expect(formatDownloadTime(0)).toBeNull();
    expect(formatDownloadTime(13.3 * GB)).toBe('about 38 min');
    expect(formatDownloadTime(40 * GB)).toBe('about 1.9 h');
  });
});

describe('the preselected word', () => {
  it('is default when a bigger model fits, minimal when only the fast one does', () => {
    expect(suggestedPreset(mac24())).toBe('default');
    expect(suggestedPreset(mac24({ totalMemoryBytes: 8 * GB }))).toBe('minimal');
  });
});
