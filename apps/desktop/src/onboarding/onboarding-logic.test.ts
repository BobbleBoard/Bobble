import { describe, expect, it } from 'vitest';
import type { EngineSpec } from '../settings/engine-catalog';
import {
  flavorForSource,
  formatBytes,
  hasSomethingToImport,
  lookSubtitle,
  mapExperience,
  ONBOARDING_STEPS,
  preselectSource,
  resolveMode,
  setupPlan,
  visibleSteps,
} from './onboarding-logic';

describe('flavorForSource', () => {
  it('maps codex→codex, claude→claude, and neither→bobble (the native identity)', () => {
    expect(flavorForSource('codex')).toBe('codex');
    expect(flavorForSource('claude')).toBe('claude');
    expect(flavorForSource('neither')).toBe('bobble');
  });
});

describe('resolveMode', () => {
  it('honors an explicit light/dark theme mode', () => {
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
  });

  it('falls back to the OS preference for system/null', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode(null, true)).toBe('dark');
  });
});

describe('mapExperience', () => {
  it('sets tutorial + permission mode per level', () => {
    expect(mapExperience('new')).toEqual({ tutorial: true, permissionMode: 'review-all' });
    expect(mapExperience('knows-llamacpp')).toEqual({
      tutorial: false,
      permissionMode: 'reviewer',
    });
    expect(mapExperience('no-tutorial')).toEqual({ tutorial: false, permissionMode: 'bypass' });
  });
});

describe('preselectSource', () => {
  it('prefers Claude, then Codex, else neither', () => {
    expect(preselectSource({ claude: true, codex: true })).toBe('claude');
    expect(preselectSource({ claude: false, codex: true })).toBe('codex');
    expect(preselectSource({ claude: false, codex: false })).toBe('neither');
  });
});

describe('the steps', () => {
  const claude = (mcp: number, themeMode: 'light' | 'dark' | 'system' | null) =>
    ({
      mcpServers: Array.from({ length: mcp }, () => ({})),
      theme: { themeMode },
    }) as never;
  const codex = (mcp: number, skills: number) =>
    ({
      mcpServers: Array.from({ length: mcp }, () => ({})),
      skills: Array(skills).fill('s'),
    }) as never;

  it('shows the import page only when there is something to bring', () => {
    expect(hasSomethingToImport('neither', claude(2, 'dark'), codex(2, 2), 3)).toBe(false);
    expect(hasSomethingToImport('claude', claude(0, null), null, 0)).toBe(false);
    expect(hasSomethingToImport('claude', claude(1, null), null, 0)).toBe(true);
    expect(hasSomethingToImport('claude', claude(0, 'dark'), null, 0)).toBe(true);
    // Codex's theme is the look page's job, so it alone is not "something".
    expect(hasSomethingToImport('codex', null, codex(0, 0), 0)).toBe(false);
    expect(hasSomethingToImport('codex', null, codex(0, 0), 4)).toBe(true);
    expect(hasSomethingToImport('codex', null, codex(0, 1), 0)).toBe(true);
  });

  it('walks four pages starting fresh, five with an import', () => {
    expect(visibleSteps(false)).toEqual(['welcome', 'look', 'hands-on', 'get-running']);
    expect(visibleSteps(true)).toEqual(['welcome', 'import', 'look', 'hands-on', 'get-running']);
    expect(ONBOARDING_STEPS).toHaveLength(5);
  });

  it('says "matched" only when there is an app to match', () => {
    expect(lookSubtitle('neither')).not.toMatch(/match/i);
    expect(lookSubtitle('claude')).toMatch(/Claude/);
    expect(lookSubtitle('codex')).toMatch(/Codex/);
  });
});

describe('formatBytes', () => {
  it('reads like a size', () => {
    expect(formatBytes(4_610_580_800)).toBe('4.3 GB');
    expect(formatBytes(771 * 1024 ** 2)).toBe('771 MB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
    expect(formatBytes(10)).toBe('1 MB');
  });
});

describe('setupPlan', () => {
  const engine = (id: string, extra: Partial<EngineSpec> = {}) =>
    ({ id, name: id, approxBytes: 1024 ** 3, ...extra }) as EngineSpec;

  it('counts the engines still to install and the model', () => {
    const plan = setupPlan({
      engine: engine('dflash-mlx'),
      prerequisites: [engine('rapid-mlx', { approxBytes: 512 * 1024 ** 2 })],
      installedEngineIds: new Set(),
      modelBytes: 4 * 1024 ** 3,
      modelPresent: false,
    });
    expect(plan.engines.map((e) => e.id)).toEqual(['rapid-mlx', 'dflash-mlx']);
    expect(plan.engineBytes).toBe(1.5 * 1024 ** 3);
    expect(plan.totalBytes).toBe(5.5 * 1024 ** 3);
  });

  it('skips what is installed, what arrives with the model, and a model on disk', () => {
    const plan = setupPlan({
      engine: engine('dflash-mlx'),
      prerequisites: [engine('rapid-mlx'), engine('mlx-lm', { autoInstalls: true })],
      installedEngineIds: new Set(['rapid-mlx']),
      modelBytes: 4 * 1024 ** 3,
      modelPresent: true,
    });
    expect(plan.engines.map((e) => e.id)).toEqual(['dflash-mlx']);
    expect(plan.modelBytes).toBe(0);
    expect(
      setupPlan({
        engine: engine('llamacpp', { autoInstalls: true }),
        prerequisites: [],
        installedEngineIds: new Set(),
        modelBytes: 0,
        modelPresent: true,
      }).totalBytes,
    ).toBe(0);
  });
});
