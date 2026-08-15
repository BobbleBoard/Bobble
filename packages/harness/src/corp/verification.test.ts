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
    expect(text).toContain('comes OUT of your report, or you go and make it true');
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
    expect(ceo).toContain('did it WORK');
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

describe('finalCheck — the CEO routes faults back, it does not silently repair', () => {
  const ceo = () =>
    finalCheck({
      claims: ['The app converts PNG to JPG'],
      profile: classifyVerification('build me a converter app'),
      perspective: 'ceo',
    });

  /*
   * the user: the CEO "needs to test itself, verify, tell the manager if anything is
   * wrong". Run 5 ended with the CEO building the product alone and reporting it
   * done — a team that never learned its work was broken.
   */
  it('sends anything wrong back to the manager', () => {
    expect(ceo()).toContain('talk_to_manager');
    expect(ceo()).toMatch(/BACK TO THE MANAGER/);
  });

  it('forbids quietly fixing it alone', () => {
    expect(ceo()).toMatch(/[Dd]o not quietly fix it yourself/);
  });

  /* Reference material is evidence for the review, gathered by the team. */
  it('asks the manager for specialists it cannot check itself', () => {
    expect(ceo()).toMatch(/specialist/i);
    expect(ceo()).toMatch(/reference/i);
  });

  it('checks before it answers the user', () => {
    expect(ceo()).toMatch(/Only when you have checked/);
  });

  /* Everyone else keeps the original instruction — they have nobody to hand to. */
  it('leaves the engineer perspective fixing its own faults', () => {
    const eng = finalCheck({
      claims: ['it builds'],
      profile: classifyVerification('build me a converter app'),
      perspective: 'engineer',
    });
    expect(eng).toContain('Fix whatever this turns up');
    expect(eng).not.toContain('talk_to_manager');
  });
});

describe('finalCheck — the CEO tests it visually, as the end user', () => {
  const ceo = () =>
    finalCheck({
      claims: ['The app converts PNG to JPG'],
      profile: classifyVerification('build me a desktop converter app'),
      perspective: 'ceo',
    });

  /*
   * MEASURED, run 6: the CEO's whole verification was edit package.json,
   * `npm run build`, `cp` the DMG to /Applications, `ls`. It then told the user
   * "the application is now ready to use" over an app whose conversion core
   * could not be require()d. Each of those commands ran clean, which is exactly
   * why the check has to name them and rule them out.
   */
  it('rules out the four things run 6 mistook for testing', () => {
    const t = ceo();
    expect(t).toMatch(/BUILDING IS NOT TESTING/);
    expect(t).toMatch(/Packaging is not testing/);
    expect(t).toMatch(/Copying it into a[\s\S]{0,20}folder is not testing/);
    expect(t).toMatch(/`ls` is not testing/);
  });

  it('tells it to open the product and do the real thing', () => {
    expect(ceo()).toMatch(/OPEN THE PRODUCT/);
    expect(ceo()).toMatch(/real file, a real input, the real action/);
  });

  it('tells it to LOOK — with its eyes, at an image', () => {
    const t = ceo();
    expect(t).toMatch(/LOOK AT THE RESULT WITH YOUR EYES/);
    expect(t).toMatch(/[Ss]creenshot/);
  });

  /* Order matters for a 4B: this must lead, not trail the routing rules. */
  it('puts the user-test FIRST, ahead of the routing rules', () => {
    const t = ceo();
    expect(t.indexOf('TEST IT AS THE END USER')).toBeLessThan(
      t.indexOf('WHAT YOU DO WITH WHAT YOU FIND'),
    );
  });

  it('makes "I could not open it" a reportable finding, not a silence', () => {
    expect(ceo()).toMatch(/cannot open it, say so plainly/);
  });

  /* The perspective framing has to put it IN the user's chair, not beside it. */
  it('casts the CEO as the user about to try it', () => {
    expect(ceo()).toMatch(/You are now THE USER/);
    expect(ceo()).toMatch(/did it WORK/);
  });
});
