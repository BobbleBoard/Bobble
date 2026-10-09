/**
 * THE FINAL CHECK — what "verify your work" has to mean to be worth anything.
 *
 * The user, after a corp run shipped work it described in the same breath as broken:
 *
 *   "is it really actually going and prompting the model directly whenever anyone
 *   submits to 'visually verify work if applicable'… better yet determine at the
 *   very start of the task via a classifier if visual verification is going to be
 *   applicable and then per contract do the same, and then seed the prompt
 *   accordingly… asking for general things, list out every claim that was just
 *   made about the final product state and verify it completely, anything visual,
 *   look at it, anything functional, test it right now, any UI, drive it and make
 *   new tests right now and make sure they're green, utilize specialists if
 *   applicable at all, this is a final check."
 *
 * What was there before was a fixed six-line reminder, identical for every task
 * and every contract, whose second call was accepted unconditionally ("no further
 * checks, no refusals"). It had the engineer's own `summary` and `verification`
 * in hand and ignored both.
 *
 * THE PART THAT IS NOT PROMPT TEXT. {@link finalCheck} takes the claims the agent
 * JUST MADE and hands them back one per line, numbered, to be discharged. That is
 * mechanical — the harness quoting the model to itself — which matters because
 * prompt text has demonstrably stopped moving these behaviours. Run 6 listed four
 * `.svg` files that were not on disk and said the project "opens in Godot"
 * without ever running Godot, which was installed and named in its own briefing.
 * Both are claims, and a claim you must answer one by one is harder to leave
 * standing than an instruction you must remember to follow.
 */

/** What verifying actually MEANS for this piece of work. */
export interface VerificationProfile {
  /** There is something to LOOK at — it can be wrong while being valid. */
  readonly visual: boolean;
  /** There is something to RUN — output, exit code, behaviour. */
  readonly functional: boolean;
  /** There is something to DRIVE — a user moves through it. */
  readonly ui: boolean;
  /** A program the work needs in order to open or run at all, if one is named. */
  readonly runtime: string | null;
}

/** Words that mean somebody has to LOOK. A thing can build and still be wrong. */
const VISUAL_WORDS = [
  'game',
  'image',
  'picture',
  'photo',
  'icon',
  'sprite',
  'render',
  'animation',
  'video',
  'chart',
  'graph',
  'plot',
  'diagram',
  'design',
  'layout',
  'css',
  'style',
  'theme',
  'colour',
  'color',
  'screenshot',
  'visual',
  'slide',
  'poster',
  'logo',
  'ui',
  'screen',
  'page',
  'website',
  'web page',
  'pdf',
  '3d',
  'model',
  'scene',
];

/** Words that mean somebody has to RUN it and read what came back. */
const FUNCTIONAL_WORDS = [
  'script',
  'program',
  'tool',
  'cli',
  'command',
  'api',
  'endpoint',
  'server',
  'function',
  'algorithm',
  'parser',
  'converter',
  'calculate',
  'compute',
  'sort',
  'search',
  'test',
  'benchmark',
  'pipeline',
  'build',
  'compile',
  'game',
  'app',
  'application',
  'bot',
  'scraper',
];

/** Words that mean somebody has to DRIVE it — click, type, move, play. */
const UI_WORDS = [
  'ui',
  'interface',
  'button',
  'form',
  'menu',
  'dashboard',
  'app',
  'application',
  'website',
  'web page',
  'page',
  'game',
  'screen',
  'window',
  'click',
  'input',
  'keyboard',
  'controls',
  'player',
  'navigation',
  'editor',
];

/**
 * Programs a piece of work can be written FOR, and therefore cannot be verified
 * without. Ordered so the most specific match wins.
 */
const RUNTIMES: ReadonlyArray<{ readonly words: readonly string[]; readonly cmd: string }> = [
  { words: ['godot'], cmd: 'godot' },
  { words: ['unity'], cmd: 'unity' },
  { words: ['blender'], cmd: 'blender' },
  { words: ['rust', 'cargo'], cmd: 'cargo' },
  { words: ['python'], cmd: 'python3' },
  { words: ['node', 'npm', 'typescript', 'javascript'], cmd: 'node' },
  { words: ['ffmpeg'], cmd: 'ffmpeg' },
];

/*
 * WHOLE WORDS ONLY. This was `text.includes(w)`, and MEASURED consequences:
 * 'ui' matches inside "build" and "requirements", so `profile.ui` fired on
 * nearly every brief ever written; 'rust' matches inside "trusted", so "a
 * trusted local converter" resolved its runtime to `cargo`. A classifier that
 * says yes to everything is not a classifier.
 */
const hasAny = (text: string, words: readonly string[]): boolean =>
  words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));

/**
 * Decide what verification this text implies — run on the TASK at the start of a
 * run, and again on each CONTRACT, because a contract to write a sprite sheet and
 * a contract to write a save-file parser need different proof even inside one
 * project.
 *
 * Deliberately deterministic rather than a model call: it runs on every contract,
 * a wrong answer here silently weakens every downstream check, and "does the word
 * 'game' appear" is not a judgement worth a turn on the one slot.
 */
export function classifyVerification(text: string): VerificationProfile {
  const t = text.toLowerCase();
  const runtime = RUNTIMES.find((r) => hasAny(t, r.words))?.cmd ?? null;
  return {
    visual: hasAny(t, VISUAL_WORDS),
    functional: hasAny(t, FUNCTIONAL_WORDS),
    ui: hasAny(t, UI_WORDS),
    runtime,
  };
}

/**
 * The line seeded into a role's brief AT THE START, so "verify it" already has a
 * meaning by the time the work is done rather than arriving as a surprise at
 * submission. Empty when the text implies nothing in particular — a briefing that
 * says nothing is worse than no briefing, because it teaches the role to skim.
 */
export function verificationBriefing(profile: VerificationProfile): string {
  const parts: string[] = [];
  if (profile.visual) parts.push('something to LOOK at');
  if (profile.functional) parts.push('something to RUN');
  if (profile.ui) parts.push('something to DRIVE');
  if (parts.length === 0) return '';
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const runtime =
    profile.runtime !== null
      ? ` It is written for \`${profile.runtime}\` — verifying it means running it THERE, so make sure that exists before you build.`
      : '';
  return `HOW THIS WORK GETS VERIFIED: there is ${list} here. That is what "check it works" has to mean on this job — not that it compiled, not that the file exists.${runtime}`;
}

/**
 * Split what an agent said into the individual CLAIMS it made.
 *
 * Bullets and numbered lines first (a small model reports in lists), then
 * sentences. Kept crude on purpose: the goal is not perfect claim extraction, it
 * is that the agent sees its own assertions enumerated and has to answer them one
 * at a time instead of re-reading a paragraph it already believes.
 */
export function extractClaims(...texts: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (text === undefined || text.trim() === '') continue;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim().replace(/^([-*•]|\d+[.)])\s*/, '');
      if (line === '') continue;
      // A heading ("## Status") asserts nothing; a sentence does.
      if (/^#{1,6}\s/.test(rawLine.trim())) continue;
      const pieces = line.split(/(?<=[.!?])\s+(?=[A-Z"'`])/);
      for (const piece of pieces) {
        const claim = piece.trim().replace(/\s+/g, ' ');
        // Too short to be an assertion ("Done", "✓") and not worth a line.
        if (claim.length < 12) continue;
        if (!out.includes(claim)) out.push(claim);
      }
    }
  }
  return out.slice(0, MAX_CLAIMS);
}

/** Enough to be thorough, few enough that the list still reads as a checklist. */
const MAX_CLAIMS = 12;

/** Whose eyes the check is done through. */
export type VerificationPerspective = 'engineer' | 'manager' | 'ceo';

/**
 * Who the reviewer is standing in for, and what question that makes them ask.
 *
 * The user: "the manager and CEO should be given the whole shebang about how they are
 * looking from the point of view of the ceo (who gave the manager the vision) and
 * the ceo from the point of view of the user (who asked them for this) and are
 * going to really look and tell: did this work out in the end as requested."
 */
const PERSPECTIVE: Record<VerificationPerspective, { readonly who: string; readonly ask: string }> =
  {
    engineer: {
      who: 'Read this back as YOUR MANAGER will, who has to trust it without rebuilding it.',
      ask: 'Would this survive somebody else opening it?',
    },
    manager: {
      who: 'Read this back as THE CEO will — the person who gave you the vision and who has to answer to the user for it.',
      ask: 'Is this the thing the CEO described to you, or is it the thing that was easy to finish?',
    },
    ceo: {
      who: 'You are now THE USER — the person who asked for this, who has not seen any of the work, who will not read the source, and who is about to open it and try it. Stop reading about the product and USE it.',
      ask: 'Open it and do what they asked it to do. Did it actually do it — in front of you, just now? Not "is there a deliverable", not "did it build" — did it WORK.',
    },
  };

/**
 * WHAT THE CEO IS TOLD EVERY TIME THE TEAM HANDS SOMETHING BACK.
 *
 * The user: "the most pragmatic thing to do is after the manager returns any talk to
 * tool call, we put a lot of testing instructions." The tool result is the one
 * place the CEO cannot skim past — it is the answer it was blocked waiting for —
 * so that is where the pressure goes, on EVERY return that has something on disk
 * to open, not only the clean one.
 *
 * MEASURED, run 6. The CEO's entire verification was four commands: edit
 * package.json, `npm run build`, `cp` the DMG into /Applications, `ls` that
 * folder. It then told the user "the application is now ready to use". The app's
 * conversion core could not be require()d — duplicate declarations — and its drop
 * zone was wired to a renderer function faking success with a setTimeout.
 *
 * Every one of those four commands ran clean, exited 0 and printed something.
 * That is precisely why they are named and ruled out here by name: a general
 * "really test it" does not dislodge a habit that already feels like testing.
 */
export const END_USER_TEST = [
  '- Drive the product the way a real user would, across the ENTIRE project —',
  '  by automation where you can, visually where it applies.',
  '- Do every main thing it was built to do, with real inputs. Drive it, do not',
  '  read it.',
  '- Building, packaging, copying it somewhere and `ls` are not testing.',
  '- Write every problem to `.scratch/verification.md` as you find it: what you',
  '  did, what you expected, what happened, which file.',
].join('\n');

/**
 * The final check itself: the agent's own claims, back at it, one per line, plus
 * exactly the kinds of proof this job admits.
 *
 * Never a bare "verify your work" — that is the instruction that has been in
 * place all along while runs shipped empty placeholders and files that did not
 * exist.
 */
export function finalCheck(opts: {
  readonly claims: readonly string[];
  readonly profile: VerificationProfile;
  readonly perspective: VerificationPerspective;
  /** The CEO's anchor: what the user actually asked for. */
  readonly vision?: string;
  /**
   * Which hand-back this is, 1-based. Only the CEO uses it, and only to bias
   * the FIRST one toward another round of feedback — see the ending it builds.
   */
  readonly round?: number;
}): string {
  const { claims, profile, perspective } = opts;

  /*
   * THE CEO'S CHECK IS A FLAT LIST, AND NOTHING ELSE.
   *
   * The user: "your guidelines should essentially be able to be put into a clean
   * bulleted list." The previous version was ~45 lines in five titled sections
   * whose own ordering contradicted itself — it announced "This comes before
   * anything else" from the MIDDLE of the block. At 4B, sections are where
   * instructions go to be skimmed.
   *
   * Order is load-bearing and was wrong. The claims list used to come FIRST, and
   * it is machine-extracted from the manager's own sign-off — so a manager that
   * wrote "All tests pass" and "The build completes with no errors" had those
   * promoted into numbered, mandatory verification targets, twenty lines above
   * the line saying a build is not verification. The harness was mandating the
   * exact commands that shipped run 6. Actions first; claims after, as things to
   * discharge BY using the product.
   */
  if (perspective === 'ceo') {
    /*
     * THE BIAS POINTS AT THE RECOVERABLE OPTION, AND HARDEST ON ROUND ONE.
     *
     * The user: "there will always be bias in the prompt, you want to ensure that
     * the bias is toward the safer option especially at the start… we
     * especially at the 4b class bias the attention mechanism an incredible
     * degree away from submitting that turn."
     *
     * The two outcomes used to sit in separate bullets as separate rules, which
     * is not a decision the model ever has to make consciously. Naming them as
     * a numbered fork forces the choice, and naming WHICH ROUND THIS IS is what
     * moves the weight — far harder for a 4B to skip than an abstract "be sure".
     *
     * The asymmetry justifies it: a wrong "send feedback" costs one round; a
     * wrong "it is finished" ships a broken product to the user, which is the
     * failure this whole file exists to stop.
     */
    const round = opts.round ?? 1;
    const out: string[] = [
      'THIS CHECK DECIDES WHETHER YOU CAN ANSWER THE USER.',
      '',
      '- Drive the product the way a real user would, across the ENTIRE project —',
      '  by automation where you can, visually where it applies.',
      '- Do every main thing it was built to do, with real inputs. Drive it, do not',
      '  read it.',
      '- Building, packaging, copying it somewhere and `ls` are not testing.',
      '- Write every problem to `.scratch/verification.md` as you find it: what you',
      '  did, what you expected, what happened, which file.',
      '',
      'THEN THERE ARE TWO WAYS TO END THIS TURN:',
      '',
      '  1. Send the manager your list with `talk_to_manager` — a round of feedback,',
      '     so the team improves the app. Do not fix it yourself.',
      '  2. Tell the user the product is finished.',
      '',
      ...(round <= 1
        ? [
            'THIS IS THE FIRST ROUND. A build like this is rarely right the first',
            'time. Take 1 unless you drove all of it and genuinely found nothing',
            'wrong — be really sure before you choose 2.',
          ]
        : ['Choose 2 only when your list is empty. Otherwise send it back.']),
    ];
    if (profile.runtime !== null) {
      out.push(
        `- It is written for \`${profile.runtime}\`. Load it THERE, in a way that exits by`,
        '  itself — a normal GUI window never returns and your turn hangs with it.',
      );
    }
    if (claims.length > 0) {
      out.push('', 'THE TEAM CLAIMED THESE. Check each one by using the product:', '');
      claims.forEach((c, i) => {
        out.push(`  ${i + 1}. ${c}`);
      });
    }
    /*
     * `vision` is the CEO's OWN brief to the manager (message + any divisions),
     * not the user's words — labelling it "what they asked for, verbatim" made
     * the harness certify the CEO's paraphrase as the user's request, so drift
     * was rubber-stamped rather than caught. Label it for what it is.
     */
    if (opts.vision !== undefined && opts.vision.trim() !== '') {
      out.push('', `WHAT YOU BRIEFED THE TEAM WITH: ${opts.vision.trim()}`);
    }
    return out.join('\n');
  }

  const p = PERSPECTIVE[perspective];
  const lines: string[] = ['THIS IS THE FINAL CHECK. Do it now, in this turn.', ''];

  if (claims.length > 0) {
    lines.push(
      'EVERY CLAIM YOU JUST MADE ABOUT THE FINISHED PRODUCT, listed back to you.',
      'Take them ONE AT A TIME and establish each is true — by doing the thing that',
      'would show it false, not by re-reading what you wrote:',
      '',
    );
    claims.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c}`);
    });
    lines.push(
      '',
      'A claim you cannot demonstrate right now is not one you may pass on — say',
      'plainly that you could not check it.',
      '',
    );
  }

  const musts: string[] = [];
  if (profile.visual) {
    musts.push(
      'ANYTHING VISUAL — LOOK AT IT. Open it, render it, screenshot it and view the image. A file that exists and a picture that is right are different facts.',
    );
  }
  if (profile.functional) {
    musts.push(
      'ANYTHING FUNCTIONAL — RUN IT RIGHT NOW and read what came back. Not "it should print", what it printed.',
    );
  }
  if (profile.ui) {
    musts.push(
      'ANY UI — DRIVE IT. Move through it as the user would and watch what happens. Tests that already passed prove nothing about what you just changed.',
    );
  }
  if (profile.runtime !== null) {
    musts.push(
      `THE RUNTIME — this is written for \`${profile.runtime}\`. Confirm it is installed and LOAD THE WORK IN IT. Saying it "will open" in a program you never launched is the single failure this check exists to catch. RUN IT IN A WAY THAT EXITS BY ITSELF — a validate/headless/\`--quit\` mode: a normal GUI window NEVER RETURNS, and your turn hangs with it.${
        profile.runtime === 'godot'
          ? ' For Godot the exact command is `godot --headless --quit --path .` — it loads every script and scene, PRINTS EVERY PARSE ERROR, and exits. `-e` and a bare `--path` open the editor and hang forever.'
          : ''
      }`,
    );
  }
  musts.push(
    'USE THE SPECIALISTS if any of this is beyond what you can check yourself — a tester, the visual specialist, the auditor. A second pair of eyes that did not build it is the point of having them.',
  );

  lines.push('WHAT CHECKING MEANS HERE:', '');
  for (const m of musts) lines.push(`  - ${m}`);
  lines.push('', p.who, p.ask, '');

  if (opts.vision !== undefined && opts.vision.trim() !== '') {
    lines.push(`WHAT THEY ASKED FOR, verbatim: ${opts.vision.trim()}`, '');
  }

  lines.push(
    'Fix whatever this turns up — now, not in a note about what remains. Then say',
    'what you actually did to check, and what you actually saw.',
  );
  return lines.join('\n');
}
