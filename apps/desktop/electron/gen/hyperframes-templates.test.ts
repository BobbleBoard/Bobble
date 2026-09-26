import { contrastRatio, oklch } from '@pi-desktop/charts';
import { describe, expect, it } from 'vitest';
import { buildSceneDocument, secondsFromPrompt } from './hyperframes-still.js';
import {
  cardColours,
  colourWords,
  isRequest,
  NEEDS_SCENE,
  NEEDS_WORDS,
  planMotion,
  quotedStrings,
  type TitleCard,
  titleCardDocument,
  titleSetting,
  withoutInstructions,
} from './hyperframes-templates.js';

/** the user's prompt, verbatim — the one that came back as a card of its own words (twice). */
const LAUNCH_DAY =
  "10-second animated title card with the text 'Launch day' in bright yellow bold letters centered on a dark gradient background with subtle pulse animation";
/** The visual-quality research's brief (§2.2.6). */
const TIDEWELL =
  'Make a 6-second animated title card for our product launch: "Tidewell" with the tagline "Stop leaks before they start", in our brand teal.';

const card = (prompt: string): TitleCard => {
  const plan = planMotion(prompt);
  if (plan.kind !== 'title-card') throw new Error(`not a card: ${JSON.stringify(plan)}`);
  return plan.card;
};

/** The words a document puts on screen (tags gone, entities back), as the DOM would read them. */
const shownText = (doc: string): string =>
  (/<body>([\s\S]*)<\/body>/.exec(doc)?.[1] ?? '')
    .replace(/<\/(?:h1|div)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();

describe('the REAL "Launch day" prompt', () => {
  it('is a title card that says "Launch day" — only that', () => {
    const c = card(LAUNCH_DAY);
    expect(c.title).toBe('Launch day');
    expect(c.tagline).toBeUndefined();
    const doc = buildSceneDocument(LAUNCH_DAY, { width: 640, height: 360, seconds: 10, fps: 12 });
    expect(shownText(doc)).toBe('Launch day');
    expect(doc).not.toMatch(
      /animated title card|bright yellow|gradient background|pulse animation/,
    );
  });

  it('in bright yellow, bold, on a dark ground, pulsing', () => {
    const c = card(LAUNCH_DAY);
    expect(c.ink).toBeDefined();
    const ink = oklch(c.ink as string);
    expect(ink.h).toBeGreaterThan(80);
    expect(ink.h).toBeLessThan(110); // yellow
    expect(ink.l).toBeGreaterThan(0.8); // bright
    // Full strength, not cream: MEASURED, the first cut made it #FFE28F (C 0.107).
    expect(ink.c).toBeGreaterThanOrEqual(oklch('#FFD60A').c - 0.005);
    expect(c.bold).toBe(true);
    expect(c.pulse).toBe(true);
    expect(c.light).toBe(false);
    expect(c.paper).toBeUndefined(); // "dark gradient" is the default plate
    const doc = titleCardDocument(c, { width: 640, height: 360, seconds: 10 });
    expect(doc).toContain(`color: ${cardColours(c).ink}`);
    expect(doc).toContain('font-weight: 800');
    expect(doc).toContain('hf-breathe');
  });

  it('is ten seconds long when the caller did not say', () => {
    expect(secondsFromPrompt(LAUNCH_DAY)).toBe(10);
    expect(secondsFromPrompt(TIDEWELL)).toBe(6);
    expect(secondsFromPrompt('a 1.5 min intro')).toBe(90);
    expect(secondsFromPrompt('a 10s intro "Hello"')).toBe(10);
    expect(secondsFromPrompt('an 8 sec title card "Hello"')).toBe(8);
    expect(secondsFromPrompt('Top 5 sellers')).toBeUndefined();
  });

  it('never reads a length out of the quoted words, or a decade as seconds', () => {
    expect(secondsFromPrompt('a title card "Back to the 1990s"')).toBeUndefined();
    expect(secondsFromPrompt('a title card "Only 30s left"')).toBeUndefined();
    expect(secondsFromPrompt('Back to the 90s')).toBeUndefined();
    expect(secondsFromPrompt('the 30s were loud')).toBeUndefined();
    expect(secondsFromPrompt("rock of the '80s")).toBeUndefined();
    expect(secondsFromPrompt('1990s revival')).toBeUndefined();
    // A decade in a plain title is still the title, not a request.
    expect(isRequest('Back to the 90s')).toBe(false);
    expect(card('Back to the 90s').title).toBe('Back to the 90s');
    expect(card('a 5-second title card "Back to the 1990s"').title).toBe('Back to the 1990s');
  });
});

describe('the research brief (Tidewell)', () => {
  it('title and tagline from its quotes, in the brand teal', () => {
    const c = card(TIDEWELL);
    expect(c.title).toBe('Tidewell');
    expect(c.tagline).toBe('Stop leaks before they start');
    const h = oklch(c.ink as string).h;
    expect(h).toBeGreaterThan(170);
    expect(h).toBeLessThan(200); // teal
    const doc = buildSceneDocument(TIDEWELL, { width: 1280, height: 720, seconds: 6, fps: 12 });
    expect(shownText(doc)).toBe('Tidewell\nStop leaks before they start');
  });
});

describe('what a prompt is', () => {
  it('a request (its words are instructions) or the words themselves', () => {
    for (const p of [
      LAUNCH_DAY,
      TIDEWELL,
      'a bold title card that slides in and glows',
      'animated title: Grand opening',
      'title card for the Tidewell launch',
      'Make me a 5 second motion graphics title: Bobble makes motion graphics',
      'kinetic typography: Bobble makes motion graphics',
    ]) {
      expect(isRequest(p), p).toBe(true);
    }
    for (const p of [
      'Launch day',
      'Bobble makes motion graphics',
      'The future is here',
      'Rising bars',
    ]) {
      expect(isRequest(p), p).toBe(false);
    }
  });

  it('the words themselves are the card (as they always were)', () => {
    expect(card('Bobble makes motion graphics').title).toBe('Bobble makes motion graphics');
    expect(card('Launch day.').title).toBe('Launch day');
  });

  it('words after a colour, a label or a "for" are found without quotes', () => {
    expect(
      card('Make me a 5 second motion graphics title: Bobble makes motion graphics').title,
    ).toBe('Bobble makes motion graphics');
    expect(card('a title card with the text Launch day in yellow').title).toBe('Launch day');
    expect(card('an intro saying Welcome back, on a white background').title).toBe('Welcome back');
    expect(card('a title card for the Tidewell launch').title).toBe('Tidewell launch');
  });

  it('a title card with no words is refused with the fix, never printed', () => {
    const plan = planMotion('a bold title card that slides in and glows');
    expect(plan).toEqual({ kind: 'refuse', reason: 'needs-words', message: NEEDS_WORDS });
    expect(() =>
      buildSceneDocument('a bold title card that slides in and glows', {
        width: 640,
        height: 360,
        seconds: 3,
        fps: 12,
      }),
    ).toThrow(/Put them in quotes/);
  });

  it('a description of a picture is refused: HyperFrames draws HTML (REAL: the radar request)', () => {
    for (const p of [
      'an animated radar chart of my skills: speed 8, power 6, range 9',
      'make a 5 second animation of a bouncing ball',
    ]) {
      const plan = planMotion(p);
      expect(plan.kind, p).toBe('refuse');
      if (plan.kind === 'refuse') expect(plan.message).toBe(NEEDS_SCENE);
    }
  });

  it('an authored scene passes through untouched', () => {
    expect(planMotion('<div class="stage">…</div>')).toEqual({ kind: 'scene' });
  });
});

describe('quotes and colours', () => {
  it('double, curly and single quotes — not apostrophes', () => {
    expect(quotedStrings('a card "One" then “Two” then ‘Three’ then \'Four\'')).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
    ]);
    expect(quotedStrings("Tidewell's launch, it's here")).toEqual([]);
    expect(card('a title card "Don\'t stop" in red').title).toBe("Don't stop");
  });

  it('the colour of the words, and the colour of the ground, read from how they are said', () => {
    expect(colourWords('yellow letters on a navy background')).toEqual({
      ink: '#FFD60A',
      paper: '#1F3A5F',
    });
    expect(colourWords('in our brand teal').ink).toBe('#2EC4B6');
    expect(colourWords('a card in #FF00AA').ink).toBe('#FF00AA');
    expect(colourWords('on a dark gradient background')).toEqual({});
  });

  it('"bright" is the colour at full strength — never paler, and white stays white', () => {
    for (const word of ['yellow', 'teal', 'blue', 'red', 'orange', 'green', 'pink']) {
      const plain = colourWords(`${word} letters`).ink as string;
      const bright = colourWords(`bright ${word} letters`).ink as string;
      expect(oklch(bright).c, word).toBeGreaterThanOrEqual(oklch(plain).c - 0.002);
      expect(Math.abs(oklch(bright).l - oklch(plain).l), word).toBeLessThan(0.01);
      expect(Math.abs(oklch(bright).h - oklch(plain).h), word).toBeLessThan(3);
    }
    expect(colourWords('bright white letters').ink).toBe('#FFFFFF');
    // Pale goes the other way: lighter and softer.
    const pale = oklch(colourWords('pale blue letters').ink as string);
    expect(pale.l).toBeGreaterThan(oklch('#4C8DFF').l);
    expect(pale.c).toBeLessThan(oklch('#4C8DFF').c);
  });

  it('words the ground would swallow turn the ground over, not the colour asked for', () => {
    const navyWords = cardColours({
      title: 'x',
      ink: '#1F3A5F',
      light: false,
      pulse: false,
      bold: false,
    });
    expect(navyWords.ink).toBe('#1F3A5F');
    expect(contrastRatio(navyWords.ink, navyWords.paper)).toBeGreaterThanOrEqual(3);
    // A named ground keeps its colour; the words change instead.
    const onNavy = cardColours({
      title: 'x',
      ink: '#1F3A5F',
      paper: '#1F3A5F',
      light: false,
      pulse: false,
      bold: false,
    });
    expect(contrastRatio(onNavy.ink, onNavy.paper)).toBeGreaterThanOrEqual(3);
  });
});

/*
 * Without quotes the words are found where people put them, and nothing that
 * is an instruction may ride along onto the card. Each of these printed an
 * instruction (or took a word for a colour) in the first cut of this file.
 */
describe('no instruction on the card, however the words are given', () => {
  const cases: Array<[string, string, string?]> = [
    ['Launch day in yellow', 'Launch day'],
    ['Coming soon, in gold on black', 'Coming soon'],
    ['Coming soon — in gold, on black', 'Coming soon'],
    ['make an intro: the words Coming Soon in gold', 'Coming Soon'],
    ['animate the words Coming Soon', 'Coming Soon'],
    ['kinetic typography of the phrase less is more', 'less is more'],
    ['Launch day title card, yellow, 10 seconds', 'Launch day'],
    ['Tidewell launch title card in teal', 'Tidewell launch'],
    ['Pixel Forge YouTube intro', 'Pixel Forge'],
    ['an intro titled The Long Road in amber on a black background', 'The Long Road'],
    ['a title card with text Grand Opening centered on a dark background', 'Grand Opening'],
    ['title card saying Launch day. Make it teal.', 'Launch day'],
    ['Hello, make it pulse', 'Hello'],
    ['a title card for Bobble in our brand orange, 8 seconds, with a pulse', 'Bobble'],
    [
      'a title card with the text Launch day and a tagline Doors open at nine, in yellow',
      'Launch day',
      'Doors open at nine',
    ],
  ];
  it.each(cases)('%s → %s', (prompt, title, tagline) => {
    const c = card(prompt);
    expect(c.title).toBe(title);
    expect(c.tagline).toBe(tagline);
  });

  it('a label with only a colour after it names no words — refused, never "in yellow" printed', () => {
    for (const p of [
      'a title card with text in yellow',
      'a title card with the text in yellow on black',
    ]) {
      expect(planMotion(p).kind, p).toBe('refuse');
    }
  });

  it('title case is a title: "Men in Black" and "Launch Day, Gold Edition" are the words', () => {
    expect(card('Men in Black').title).toBe('Men in Black');
    expect(card('Men in Black').ink).toBeUndefined();
    expect(card('Dancing In The Dark').title).toBe('Dancing In The Dark');
    expect(card('Launch Day, Gold Edition').title).toBe('Launch Day, Gold Edition');
    expect(card('Welcome, with love').title).toBe('Welcome, with love');
  });

  it('style words inside the words are content: "bold" in a title is not a weight', () => {
    expect(card('Be brave, bold and kind').bold).toBe(false);
    expect(card('a card "Be Bold" on a light background').bold).toBe(false);
    expect(card('"Out of the Blue" title card').ink).toBeUndefined();
  });

  it('"black" is a colour, not a weight; "on navy" and "white on black" name the ground', () => {
    const season = card('Make a motion graphic title "Season 2" in white on black');
    expect(season.bold).toBe(false);
    expect(season.ink).toBe('#FFFFFF');
    expect(season.paper).toBe('#111114');
    expect(card('a title card "Launch day" in yellow on navy').paper).toBe('#1F3A5F');
    expect(card('a pink neon title card saying OPEN LATE').ink).toBeDefined();
    expect(card('Launch day title card, yellow, 10 seconds').ink).toBe('#FFD60A');
  });

  it('keeps the words’ own punctuation, drops a sentence full stop', () => {
    expect(card('Grand Opening!').title).toBe('Grand Opening!');
    expect(card('Welcome back, The user!').title).toBe('Welcome back, The user!');
    expect(card('Launch day.').title).toBe('Launch day');
    expect(card('Coming soon...').title).toBe('Coming soon...');
  });

  it('withoutInstructions cuts only lower-case instructions', () => {
    expect(
      withoutInstructions('Launch day in bright yellow letters centered on a dark plate'),
    ).toBe('Launch day');
    expect(withoutInstructions('Launch day fading in')).toBe('Launch day');
    expect(withoutInstructions('Launch day that pulses')).toBe('Launch day');
    expect(withoutInstructions('Launch day — 10 seconds')).toBe('Launch day');
    expect(withoutInstructions('Men in Black')).toBe('Men in Black');
  });
});

describe('how the title is set', () => {
  it('a short title on one large line', () => {
    expect(titleSetting('Launch day', 1280, 720)).toEqual({ lines: 1, px: 122, measure: 10 });
  });

  it('a longer one on two balanced lines, larger than one thin line would be', () => {
    const two = titleSetting('Bobble makes motion graphics', 640, 360);
    expect(two.lines).toBe(2);
    expect(two.measure).toBe('motion graphics'.length);
    // One line would have been 33 px at this size.
    expect(two.px).toBeGreaterThan(50);
    const doc = titleCardDocument(
      { title: 'Bobble makes motion graphics', light: false, pulse: false, bold: false },
      { width: 640, height: 360, seconds: 4 },
    );
    expect(doc).toContain(`font-size: ${two.px}px;`);
    expect(doc).toMatch(/max-width: \d+px;/);
  });

  it('one long word cannot wrap, so it is sized to fit', () => {
    const one = titleSetting('Supercalifragilisticexpialidocious', 640, 360);
    expect(one.lines).toBe(1);
    expect(one.px * 34 * 0.56).toBeLessThanOrEqual(640 * 0.82 + 1);
  });
});

describe('a playful intro bounces in', () => {
  /* REAL (the visual suite, 4B): "Make a 6-second animated intro for my
     YouTube channel 'Byte Sized' — playful, with the title bouncing in". */
  const intro =
    "Make a 6-second animated intro for my YouTube channel 'Byte Sized' — playful, with the title bouncing in";

  it('reads the bounce from how it should move, and the words from the quotes', () => {
    const plan = planMotion(intro);
    expect(plan.kind).toBe('title-card');
    if (plan.kind !== 'title-card') return;
    expect(plan.card.title).toBe('Byte Sized');
    expect(plan.card.bounce).toBe(true);
    const calm = planMotion("'Launch day' in yellow");
    expect(calm.kind === 'title-card' && calm.card.bounce).toBe(false);
  });

  it('drops each letter in on its own beat, words kept whole, the text unchanged', () => {
    const plan = planMotion(intro);
    if (plan.kind !== 'title-card') throw new Error('not a card');
    const doc = titleCardDocument(plan.card, { width: 1280, height: 720, seconds: 6 });
    expect(doc).toContain('@keyframes hf-bounce');
    expect(doc.match(/class="hf-l"/g)).toHaveLength('ByteSized'.length);
    expect(doc.match(/class="hf-w"/g)).toHaveLength(2);
    const h1 = /<h1 data-hf-title>(.*)<\/h1>/.exec(doc)?.[1] ?? '';
    expect(h1.replace(/<[^>]+>/g, '')).toBe('Byte Sized');
    // The rise is the calm entrance; a bouncing title does not also rise.
    expect(/\.hf-card h1 \{[^}]*hf-rise/.test(doc)).toBe(false);
    expect(doc).not.toMatch(/<script|requestAnimationFrame|setTimeout/);
    // A long title still lands inside the clip's first two and a half seconds.
    const long = titleCardDocument(
      {
        title: 'The Quick Brown Fox Jumps Over The Lazy Dog',
        light: false,
        pulse: false,
        bold: false,
        bounce: true,
      },
      { width: 1280, height: 720, seconds: 6 },
    );
    const delays = [...long.matchAll(/animation-delay: (\d+)ms/g)].map((m) => Number(m[1]));
    expect(Math.max(...delays) + 1100).toBeLessThanOrEqual(2500);
  });
});

describe('the card document', () => {
  it('escapes the words, sizes the stage, and animates only with seekable CSS', () => {
    const doc = titleCardDocument(
      { title: '<b>x</b> & y', tagline: 'a "t"', light: false, pulse: false, bold: false },
      { width: 800, height: 600, seconds: 4 },
    );
    expect(doc).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(doc).toContain('a &quot;t&quot;');
    expect(doc).toContain('width: 800px; height: 600px');
    expect(doc).not.toMatch(/<script|requestAnimationFrame|setTimeout/);
    expect(doc).toContain('@keyframes hf-rise');
    expect(doc).toContain('@keyframes hf-wipe');
  });
});
