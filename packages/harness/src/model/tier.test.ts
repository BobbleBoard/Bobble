import { describe, expect, it } from 'vitest';
import { asksForTheTeam, isModelTier, MODEL_TIERS, TIER_LABEL } from './tier.js';

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
