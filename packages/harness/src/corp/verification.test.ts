import { describe, expect, it } from 'vitest';
import {
  classifyVerification,
  extractClaims,
  finalCheck,
  verificationBriefing,
} from './verification.js';

describe('classifyVerification', () => {
  it('sees a game as visual, functional, drivable, and needing its engine', () => {
    const p = classifyVerification('Build a 2D platformer game in Godot 4 with a coin counter');
    expect(p).toMatchObject({ visual: true, functional: true, ui: true, runtime: 'godot' });
  });

  it('does not call a parser visual', () => {
    const p = classifyVerification('Write a script that converts a CSV to JSON');
    expect(p.visual).toBe(false);
    expect(p.functional).toBe(true);
  });

  it('names no runtime when none is implied', () => {
    expect(classifyVerification('summarise this document').runtime).toBeNull();
  });
});

describe('verificationBriefing', () => {
  it('says what checking means, and names the runtime to establish first', () => {
    const text = verificationBriefing(classifyVerification('a Godot game'));
    expect(text).toContain('LOOK at');
    expect(text).toContain('`godot`');
    expect(text).toContain('before you build');
  });

  /* A briefing that says nothing teaches the role to skim the next one. */
  it('is empty when the text implies nothing in particular', () => {
    expect(
      verificationBriefing({ visual: false, functional: false, ui: false, runtime: null }),
    ).toBe('');
  });
});

describe('extractClaims', () => {
  it('splits bullets and sentences, and drops headings', () => {
    const claims = extractClaims(
      '## Status Update\n- Built the player controller in player.gd\n- Created four sprite files',
      'The scene opens in Godot and the coin counter increments.',
    );
    expect(claims).toContain('Built the player controller in player.gd');
    expect(claims).toContain('Created four sprite files');
    expect(claims.some((c) => c.startsWith('The scene opens in Godot'))).toBe(true);
    expect(claims.some((c) => c.includes('Status Update'))).toBe(false);
  });

  it('drops fragments too short to be an assertion, and de-duplicates', () => {
    expect(extractClaims('Done\n✓\nok')).toEqual([]);
    expect(extractClaims('The build passes cleanly', 'The build passes cleanly')).toHaveLength(1);
  });
});

describe('finalCheck', () => {
  const profile = { visual: true, functional: true, ui: true, runtime: 'godot' };

  it('numbers the claims back and refuses to let one stand undischarged', () => {
    const text = finalCheck({
      claims: ['Created four sprite files', 'The scene opens in Godot'],
      profile,
      perspective: 'engineer',
    });
    expect(text).toContain('1. Created four sprite files');
    expect(text).toContain('2. The scene opens in Godot');
    /* Reworded: the old line told the model to "go and make it true", which is
       the same instruction as "fix it yourself" that the CEO path forbids. */
    expect(text).toContain('not one you may pass on');
  });

  it('asks the manager to read it as the CEO, and the CEO as the user', () => {
    const mgr = finalCheck({ claims: ['x is done'], profile, perspective: 'manager' });
    expect(mgr).toContain('as THE CEO will');
    expect(mgr).toContain('gave you the vision');

    const ceo = finalCheck({
      claims: ['x is done'],
      profile,
      perspective: 'ceo',
      vision: 'build me a platformer',
    });
    /* Wording sharpened after run 6 — it now puts the CEO IN the user's chair
       ("You are now THE USER") rather than beside it ("read this as the user
       will"), because reading-as was satisfied by an `ls`. */
    expect(ceo).toContain('You are now THE USER');
    /* The CEO path is now a flat list; its verbs live in the bullets. */
    expect(ceo).toContain('Stop reading about the product and USE it');
    expect(ceo).toContain('build me a platformer');
  });

  /* The failure this exists for: asserting a project runs in an engine that was
   * never launched. Run 6 did exactly that with Godot installed and briefed. */
  it('demands the work actually be opened in its runtime', () => {
    const text = finalCheck({ claims: ['it opens'], profile, perspective: 'engineer' });
    expect(text).toContain('LOAD THE WORK IN IT');
    expect(text).toContain('never launched');
    // The instruction that hung two runs: "open it in its runtime" made the CEO
    // launch the Godot EDITOR, which never exits. Two processes were still alive
    // 1h19m and 19m later, each blocking its whole run.
    expect(text).toContain('RUN IT IN A WAY THAT EXITS BY ITSELF');
    // `timeout` is NOT on macOS — naming it sent every role at a command that
    // does not exist. The exit flags are the whole protection.
    expect(text).not.toContain('timeout 60');
    expect(text).toContain('godot --headless --quit --path .');
  });

  it('offers specialists always, and drops the checks that do not apply', () => {
    const plain = finalCheck({
      claims: ['it parses'],
      profile: { visual: false, functional: true, ui: false, runtime: null },
      perspective: 'engineer',
    });
    expect(plain).toContain('USE THE SPECIALISTS');
    expect(plain).not.toContain('ANYTHING VISUAL');
    expect(plain).not.toContain('ANY UI');
  });
});

describe('the CEO check is a flat list, in the order that matters', () => {
  const ceo = (claims: string[] = ['The app converts PNG to JPG']) =>
    finalCheck({
      claims,
      profile: classifyVerification('build me a desktop converter app'),
      perspective: 'ceo',
    });

  /*
   * MEASURED, run 6: the CEO's whole verification was edit package.json,
   * `npm run build`, `cp` the DMG to /Applications, `ls`. It then told the user
   * "the application is now ready to use" over an app whose conversion core
   * could not be require()d. Each command ran clean — which is why they are
   * named and ruled out by name.
   */
  it('rules out the four things run 6 mistook for testing', () => {
    const t = ceo();
    expect(t).toMatch(/Building is not testing/);
    expect(t).toMatch(/Packaging, copying it into a folder and `ls` are not/);
  });

  it('tells it to open the product and do the real thing', () => {
    expect(ceo()).toMatch(/Open the product the way the user would open it/);
    expect(ceo()).toMatch(/a real file, a real input, the real action/);
  });

  it('tells it to open what came out and look at it', () => {
    expect(ceo()).toMatch(/Open what it produced and look at it/);
  });

  it('makes "I could not open it" a reportable finding, not a silence', () => {
    expect(ceo()).toMatch(/cannot open it at all, say that plainly/);
  });

  it('casts the CEO as the user about to try it', () => {
    expect(ceo()).toMatch(/You are now THE USER/);
    expect(ceo()).toMatch(/Stop reading about the product and USE it/);
  });

  it('routes anything wrong back to the manager instead of fixing it', () => {
    const t = ceo();
    expect(t).toContain('talk_to_manager');
    expect(t).toMatch(/Do not fix it yourself/);
  });

  it('asks the manager for a specialist it cannot check itself', () => {
    expect(ceo()).toMatch(/ask the manager to put a specialist on it/);
  });

  it('answers the user only after using it', () => {
    expect(ceo()).toMatch(/only after you have used it yourself/);
  });

  /*
   * ORDER IS THE FIX. The claims are machine-extracted from the MANAGER's
   * sign-off, so a manager that wrote "All tests pass" had that promoted into a
   * numbered, mandatory verification target. With the list first, the model
   * reads "a build is not testing" BEFORE it reads "All tests pass" as claim 2.
   */
  it('puts the actions above the claims, not below them', () => {
    const t = ceo(['The app converts PNG to JPG', 'All tests pass']);
    expect(t.indexOf('Building is not testing')).toBeLessThan(t.indexOf('THE TEAM CLAIMED THESE'));
  });

  it('attributes the claims to the TEAM, which is who made them', () => {
    const t = ceo();
    expect(t).toContain('THE TEAM CLAIMED THESE');
    expect(t).not.toContain('EVERY CLAIM YOU JUST MADE');
  });

  it('does not tell it to go make an undemonstrable claim true', () => {
    expect(ceo()).not.toMatch(/make it true/);
    expect(ceo()).toMatch(/Say you could\s+not check it/);
  });

  /* the user: "your guidelines should essentially be able to be put into a clean
     bulleted list." Sections are where instructions go to be skimmed at 4B. */
  it('stays a short flat list', () => {
    const t = ceo();
    expect(t.split('\n').length).toBeLessThan(32);
    expect(t).not.toContain('WHAT CHECKING MEANS HERE');
    expect(t).not.toContain('WHAT YOU DO WITH WHAT YOU FIND');
  });

  /* `vision` is the CEO's own brief, not the user's words — do not certify it
     as verbatim, or CEO drift gets rubber-stamped instead of caught. */
  it('labels the brief as the CEO own brief, never as the user verbatim', () => {
    const t = finalCheck({
      claims: [],
      profile: classifyVerification('build a converter'),
      perspective: 'ceo',
      vision: 'build a converter, split into Backend and UI',
    });
    expect(t).toContain('WHAT YOU BRIEFED THE TEAM WITH');
    expect(t).not.toContain('verbatim');
  });
});
