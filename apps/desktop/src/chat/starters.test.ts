import { describe, expect, it } from 'vitest';
import { STARTERS } from './starters';

/*
 * These read like copy tests because they ARE copy tests. The failure they
 * guard against is the one the blind tester actually hit: the app describing
 * itself in its own plumbing. A tool name creeping into a chip is that same
 * mistake arriving through a different door.
 */
const MACHINERY = [
  'ask_user',
  'update_plan',
  'spawn_subagent',
  'talk_to_manager',
  'web_search',
  'web_fetch',
  'generate_image',
  'python_run',
  'bash',
  'tool',
  'agent',
  'prompt',
];

describe('the opening-screen starters', () => {
  it('offers four, which is what fits on one line without wrapping into a menu', () => {
    expect(STARTERS).toHaveLength(4);
  });

  it('never names internal machinery', () => {
    for (const s of STARTERS) {
      const text = `${s.label} ${s.prompt}`.toLowerCase();
      for (const word of MACHINERY) expect(text).not.toContain(word);
    }
  });

  it('fills the box with a whole request, not a category', () => {
    for (const s of STARTERS) {
      // A real sentence: long enough to show the shape of an ask, and ending
      // like one. "Writing" would fail both.
      expect(s.prompt.length).toBeGreaterThan(30);
      expect(s.prompt.trim()).toMatch(/[.?]$/);
      expect(s.prompt).not.toBe(s.label);
    }
  });

  it('keeps the chip itself glanceable', () => {
    for (const s of STARTERS) {
      // Seven, not five. The first cut capped this at five and the cap is what
      // ate "on the web" and "on my Mac" — the two facts that separate this app
      // from a text box. A chip is allowed to be a phrase.
      expect(s.label.split(' ').length).toBeLessThanOrEqual(7);
      expect(s.label).not.toMatch(/[.]$/);
    }
  });

  /*
   * WHERE, NOT JUST WHAT. Two of the four chips exist to tell a new user
   * something they cannot guess from "Running on your Mac": that this app can
   * reach the internet, and that it can touch their own disk.
   */
  it('says where the work happens on the two chips that need it', () => {
    const labels = STARTERS.map((s) => s.label);
    expect(labels).toContain('Look something up on the web');
    expect(labels).toContain('Work with a file on my Mac');
  });

  it('covers the four things the app is actually for', () => {
    expect(STARTERS.map((s) => s.icon)).toEqual(['write', 'search', 'image', 'file']);
  });
});
