import { describe, expect, it } from 'vitest';
import { DEFAULT_ADVANCED, type DesktopSettings } from '../../electron/settings/settings-contract';
import {
  EFFORT_STEPS,
  isPinnedSelection,
  levelToSlider,
  resolveEffort,
  selectionTier,
  sliderToLevel,
} from './model-selection';

const base: DesktopSettings = {
  version: 1,
  theme: { flavor: 'claude', mode: 'system' },
  permissionMode: 'reviewer',
  effort: 'medium',
  userMode: 'user',
  enginePreference: 'llamacpp',
  modelSelection: { mode: 'auto' },
  effortMode: 'auto',
  search: { brave: '', tavily: '' },
  mcpMode: 'lite',
  capabilities: { image: false, video: false, audio: false, threeD: false },
  customInstructions: '',
  iconStroke: 1.25,
  sidebarScale: 1.0,
  menuScale: 1.0,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
  experimentalGeneration: false,
  advanced: DEFAULT_ADVANCED,
  chatOrg: { projects: [], assignments: {}, pinned: [], titles: {} },
  hideDeleteChatConfirm: false,
  hideDeleteModelConfirm: false,
  computerUse: { enabled: true, apps: [] },
  memoryGuard: true,
  harnessId: 'pi-bundled',
  harnessConfigPath: '',
  toolInterface: 'schemas',
  specialistToolInterface: 'bash-cli',
  workMode: 'chat',
  powerMode: 'auto',
  showComputerUseStatusPill: true,
  engineLaunch: {},
  portableKnobs: {},
  modelsRoot: null,
  modelSpec: {},
};

describe('sliderToLevel / levelToSlider', () => {
  it('snaps 0..1 to the nearest detent', () => {
    expect(sliderToLevel(0)).toBe('low');
    expect(sliderToLevel(0.33)).toBe('medium');
    expect(sliderToLevel(0.66)).toBe('high');
    expect(sliderToLevel(1)).toBe('max');
    // clamps out-of-range
    expect(sliderToLevel(-1)).toBe('low');
    expect(sliderToLevel(2)).toBe('max');
    expect(sliderToLevel(Number.NaN)).toBe('low');
  });

  it('round-trips every level through levelToSlider → sliderToLevel', () => {
    for (const level of EFFORT_STEPS) {
      expect(sliderToLevel(levelToSlider(level))).toBe(level);
    }
    expect(levelToSlider('low')).toBe(0);
    expect(levelToSlider('max')).toBe(1);
  });
});

describe('resolveEffort', () => {
  it('uses the resolved level in both modes', () => {
    // Adaptive writes the classifier's level into `effort`, so there is exactly
    // one resolved level and no reader re-derives it.
    expect(resolveEffort({ ...base, effortMode: 'auto', effort: 'max' })).toBe('max');
    expect(resolveEffort({ ...base, effortMode: 'level', effort: 'max' })).toBe('max');
    expect(resolveEffort({ ...base, effortMode: 'auto', effort: 'low' })).toBe('low');
  });

  it('lets Adaptive reach max — the level the corp harness gates on', () => {
    // The old tier-derived mapping topped out at 'high', so a small pinned model
    // capped Adaptive at 'low' and create_production_hierarchy was never offered.
    expect(resolveEffort({ ...base, effortMode: 'auto', effort: 'max' })).toBe('max');
  });
});

describe('selection helpers', () => {
  it('isPinnedSelection is false for auto, true for tier/model', () => {
    expect(isPinnedSelection({ mode: 'auto' })).toBe(false);
    expect(isPinnedSelection({ mode: 'tier', tier: 'balanced' })).toBe(true);
    expect(isPinnedSelection({ mode: 'model', modelId: 'gemma-4-e2b-it' })).toBe(true);
  });

  it('selectionTier returns the pinned tier or null', () => {
    expect(selectionTier({ mode: 'tier', tier: 'intelligent' })).toBe('intelligent');
    expect(selectionTier({ mode: 'auto' })).toBeNull();
    expect(selectionTier({ mode: 'model', modelId: 'x' })).toBeNull();
  });
});
