import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_SKILL_NOTE,
  loadTeachSkill,
  skillBody,
  teachGiven,
  teachNote,
  wantsTeaching,
} from './teach-skill';

describe('a message that asks to learn', () => {
  it.each([
    'Can you explain how the pressure of a gas comes from molecules hitting the walls?',
    'Explain the difference between an ionic and a covalent bond',
    'Help me with this homework question on moles',
    'Give me 5 practice problems on projectile motion',
    'Walk me through integrating x sin x by parts',
    'Show that the pressure is p = (1/3) ρ <c²>',
    'Prove that the square root of 2 is irrational',
    'Quiz me on the periodic table',
    'Solve this step by step: 2x + 3 = 11',
    'How do I solve this? A 2.0 kg block slides down a 30° slope',
    'Calculate the speed of the molecule if the time between collisions is 2.0 ms',
    'Fig. 3.1 shows a molecule in a cube of side L. (a) State what is meant by …',
  ])('asks: %s', (p) => {
    expect(wantsTeaching(p)).toBe(true);
  });

  it.each([
    'explain what this function does',
    'why is my build failing?',
    'what time is it in Tokyo',
    'Make me a landing page for a ceramics studio',
    'find my notes from last week',
    'how do I get to the airport',
    'Draft a quick email to my landlord',
  ])('does not ask: %s', (p) => {
    expect(wantsTeaching(p)).toBe(false);
  });
});

describe('the skill, attached once', () => {
  it('reads the bundled SKILL.md without its frontmatter, and marks it as instructions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, 'teach'));
    writeFileSync(
      join(dir, 'teach', 'SKILL.md'),
      '---\nname: teach\ndescription: x\n---\n\n# Teach\nSmall steps.\n',
    );
    const body = loadTeachSkill({ PI_DESKTOP_SKILLS_DIR: dir });
    expect(body).toBe('# Teach\nSmall steps.');
    expect(teachNote(body ?? '')).toMatch(
      /^This message asks to learn[\s\S]*<skill_instructions name="teach">\n# Teach/,
    );
    expect(loadTeachSkill({})).toBeNull();
    expect(loadTeachSkill({ PI_DESKTOP_SKILLS_DIR: join(dir, 'nope') })).toBeNull();
    expect(skillBody('no frontmatter')).toBe('no frontmatter');
  });

  it('is given once per branch', () => {
    expect(teachGiven([])).toBe(false);
    expect(
      teachGiven([
        { type: 'custom_message', customType: HARNESS_SKILL_NOTE, details: { skill: 'teach' } },
      ]),
    ).toBe(true);
    // …or riding with the folder note, when both went out in one turn.
    expect(
      teachGiven([
        {
          type: 'custom_message',
          customType: 'harness-workspace-note',
          details: { root: '/w', skill: 'teach' },
        },
      ]),
    ).toBe(true);
    expect(
      teachGiven([{ type: 'custom_message', customType: 'other', details: { root: '/w' } }]),
    ).toBe(false);
  });

  it('the shipped skill is there and says what it must', async () => {
    const shipped = join(__dirname, '../../../../apps/desktop/resources/skills');
    const body = loadTeachSkill({ PI_DESKTOP_SKILLS_DIR: shipped }) ?? '';
    for (const must of [
      'Picture it',
      'Small steps',
      'Check',
      'practice problem',
      'animation',
      'present',
    ]) {
      expect(body).toContain(must);
    }
    // Small enough to ride beside a message: under ~1,000 tokens.
    expect(body.length).toBeLessThan(5_000);
  });
});
