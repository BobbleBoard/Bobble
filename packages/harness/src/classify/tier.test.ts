import { describe, expect, it } from 'vitest';
import { classify, TASK_CLASSES, type TaskClass } from './classify.js';
import {
  COARSE_TO_MODEL,
  type CoarseTier,
  coarseTier,
  asksForTheTeam,
  effortForClass,
  isCoarseTier,
  isModelTier,
  MODEL_TIERS,
  type ModelTier,
  modelTierForClass,
  TIER_LABEL,
} from './tier.js';

describe('coarseTier', () => {
  const cases: Record<TaskClass, CoarseTier> = {
    'simple-QA': 'quick',
    'basic-tools': 'balanced',
    other: 'balanced',
    connectors: 'balanced',
    'file-ops': 'balanced',
    '2d-art': 'balanced',
    'video-edit': 'balanced',
    perception: 'balanced',
    coding: 'complex',
    'browser-use': 'complex',
    '3d': 'complex',
    'motion-graphics': 'complex',
    'advanced-video': 'complex',
  };

  it('maps every TaskClass to its coarse tier', () => {
    for (const cls of TASK_CLASSES) {
      expect(coarseTier(cls)).toBe(cases[cls]);
    }
  });

  it('covers all task classes (exhaustive, no undefined)', () => {
    for (const cls of TASK_CLASSES) {
      expect(isCoarseTier(coarseTier(cls))).toBe(true);
    }
  });
});

describe('modelTierForClass', () => {
  const expected: Record<TaskClass, ModelTier> = {
    'simple-QA': 'fast',
    'basic-tools': 'balanced',
    other: 'balanced',
    connectors: 'balanced',
    'file-ops': 'balanced',
    '2d-art': 'balanced',
    'video-edit': 'balanced',
    perception: 'balanced',
    coding: 'intelligent',
    'browser-use': 'intelligent',
    '3d': 'intelligent',
    'motion-graphics': 'intelligent',
    'advanced-video': 'intelligent',
  };

  it('routes each class to the user-facing model tier via COARSE_TO_MODEL', () => {
    for (const cls of TASK_CLASSES) {
      expect(modelTierForClass(cls)).toBe(expected[cls]);
      expect(modelTierForClass(cls)).toBe(COARSE_TO_MODEL[coarseTier(cls)]);
    }
  });
});

describe('tier constants + guards', () => {
  it('has a label for every model tier', () => {
    for (const t of MODEL_TIERS) {
      expect(TIER_LABEL[t]).toBeTruthy();
    }
    expect(TIER_LABEL).toEqual({ fast: 'Fast', balanced: 'Balanced', intelligent: 'Intelligent' });
  });

  it('isModelTier accepts the three tiers and rejects junk', () => {
    for (const t of MODEL_TIERS) expect(isModelTier(t)).toBe(true);
    expect(isModelTier('quick')).toBe(false);
    expect(isModelTier('wizard')).toBe(false);
    expect(isModelTier(42)).toBe(false);
  });
});

describe('effortForClass', () => {
  it('sends the multi-part builds to the top of the range', () => {
    // These are projects, not errands: they want the team and the verification
    // that comes with it, and both are gated on high/max.
    expect(effortForClass('coding')).toBe('max');
    expect(effortForClass('3d')).toBe('max');
    expect(effortForClass('motion-graphics')).toBe('max');
    expect(effortForClass('advanced-video')).toBe('max');
  });

  it('keeps a plain question cheap', () => {
    expect(effortForClass('simple-QA')).toBe('low');
    expect(effortForClass('basic-tools')).toBe('medium');
    expect(effortForClass('file-ops')).toBe('medium');
  });

  it('reaches an effort that enables the corporation for a build request', () => {
    /*
     * THE REGRESSION THIS EXISTS FOR. Adaptive effort used to come from the
     * active MODEL tier, so with the Fast model pinned it was 'low' whatever was
     * asked — and `create_production_hierarchy`/`talk_to_manager` are offered
     * only at high/max. Asking Bobble to have the manager set up a Godot demo
     * therefore answered that it had no tool for contacting a manager. It was
     * right: it didn't have one. Effort follows the TASK now.
     */
    const cls = classify({ prompt: 'Ask the manager to set up a sample Godot game to demo Godot' })
      .class;
    const effort = effortForClass(cls);
    expect(['high', 'max']).toContain(effort);
  });
});

describe('asksForTheTeam', () => {
  /*
   * MEASURED, twice. the user asked "ask the manager to set up a sample Godot game"
   * and got "I don't have access to tools that can contact your manager
   * directly". A later run opened "Ask the manager to research ... and build me
   * a slideshow", classed as basic-tools → medium, so talk_to_manager was
   * stripped and ten minutes passed with no team and no explanation.
   */
  it('catches the phrasings people actually use', () => {
    expect(asksForTheTeam('Ask the manager to set up a sample Godot game')).toBe(true);
    expect(asksForTheTeam('ask the manager to research X and build me a slideshow')).toBe(true);
    expect(asksForTheTeam('Tell your team to build this')).toBe(true);
    expect(asksForTheTeam('get a team on this')).toBe(true);
    expect(asksForTheTeam('talk to the manager about it')).toBe(true);
    expect(asksForTheTeam('delegate this')).toBe(true);
    expect(asksForTheTeam('hand this off to the manager')).toBe(true);
  });

  it('does NOT fire on a passing mention — it must be a request to delegate', () => {
    expect(asksForTheTeam('what does a manager do')).toBe(false);
    expect(asksForTheTeam('my manager wants a report on team velocity')).toBe(false);
    expect(asksForTheTeam('rename these files')).toBe(false);
    expect(asksForTheTeam('summarise this team meeting transcript')).toBe(false);
  });
});
