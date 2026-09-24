import { describe, expect, it } from 'vitest';
import {
  cleanEnhanced,
  enhancePrompt,
  enhanceSystemPrompt,
  keepsQuotedWords,
  keepsTheCard,
  unwrapQuotes,
} from './prompt-enhancer';
import { canEnhance, guidelineFor } from './prompt-guidelines';

/*
 * VQ-11 lite: HyperFrames left the VIDEO dialect. Told "say what moves, then
 * the camera, then the light", the enhancer made a title-card prompt LONGER —
 * and the renderer printed every word of it as the title.
 */
describe('HyperFrames has its own enhancer dialect', () => {
  it('is motion-graphics, not video — whatever kind of job names it', () => {
    expect(guidelineFor('video', 'hyperframes').dialect).toBe('motion-graphics');
    expect(guidelineFor('image', 'hyperframes').dialect).toBe('motion-graphics');
    // A real video model still gets the video house style.
    expect(guidelineFor('video', 'ltx-2').dialect).toBe('video');
    expect(guidelineFor('video').dialect).toBe('video');
    expect(canEnhance('video', 'hyperframes')).toBe(true);
  });

  it('tells the enhancer it writes a title card whose quoted words are printed as written', () => {
    const sys = enhanceSystemPrompt('video', 'hyperframes');
    expect(sys).toContain('an animated title card');
    expect(sys).toContain('exactly as the user wrote them');
    expect(sys).toContain('Never invent words to show');
    expect(sys).not.toContain('camera: static');
  });
});

describe('a rewrite that loses the quoted words is not used', () => {
  const endpoint = { baseUrl: 'http://127.0.0.1:1/v1', model: 'tiny' };
  const reply = (content: string) =>
    (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
      )) as unknown as typeof fetch;
  const PROMPT = 'a title card "Launch day" in yellow';

  it('keeps the words: the rewrite is used', async () => {
    const good =
      'A 5-second title card "Launch day" in bright yellow letters on a dark background, rising in and settling.';
    expect(
      await enhancePrompt({
        kind: 'video',
        model: 'hyperframes',
        prompt: PROMPT,
        endpoint,
        fetchImpl: reply(good),
      }),
    ).toBe(good);
  });

  it('changes or drops them: the user’s own prompt is used', async () => {
    for (const bad of [
      'A 5-second title card "Launch Day!" in bright yellow letters on a dark background, rising in.',
      'A glowing yellow launch title card rising in over a dark night sky with sparkles.',
    ]) {
      expect(
        await enhancePrompt({
          kind: 'video',
          model: 'hyperframes',
          prompt: PROMPT,
          endpoint,
          fetchImpl: reply(bad),
        }),
      ).toBe(PROMPT);
    }
  });

  it('keepsQuotedWords', () => {
    expect(keepsQuotedWords('a card "A" and "B"', 'x "B" y "A" z')).toBe(true);
    expect(keepsQuotedWords('a card "A"', 'x "a" z')).toBe(false);
    expect(keepsQuotedWords('no quotes here', 'anything')).toBe(true);
  });

  it('a rewrite with the quoted title at its END keeps it (the cleaner used to cut the closing mark)', async () => {
    const endQuoted = 'A 6-second teal title card rising in on a dark background: "Launch day"';
    expect(
      await enhancePrompt({
        kind: 'video',
        model: 'hyperframes',
        prompt: PROMPT,
        endpoint,
        fetchImpl: reply(endQuoted),
      }),
    ).toBe(endQuoted);
  });

  it('may give words to a card that named them unquoted — never invent words for one that named none', async () => {
    const run = (prompt: string, content: string) =>
      enhancePrompt({
        kind: 'video',
        model: 'hyperframes',
        prompt,
        endpoint,
        fetchImpl: reply(content),
      });
    // The guideline's own example: "tidewell" is the user's word.
    const example = guidelineFor('video', 'hyperframes').example;
    expect(await run(example.from, example.to)).toBe(example.to);
    // A card with no words: the rewrite may not make some up.
    const noWords = 'a bold title card that slides in and glows';
    expect(
      await run(
        noWords,
        'A bold title card "Welcome" in white letters sliding in with a soft glow.',
      ),
    ).toBe(noWords);
    // Nor add a tagline the user never wrote.
    expect(
      await run(
        PROMPT,
        'A title card "Launch day" with the tagline "Doors open at nine" in yellow letters, rising in.',
      ),
    ).toBe(PROMPT);
  });

  it('an authored scene is never rewritten', async () => {
    const scene = '<div class="stage"><h1>Hi</h1></div><style>h1{animation:a 1s}</style>';
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(
      await enhancePrompt({
        kind: 'video',
        model: 'hyperframes',
        prompt: scene,
        endpoint,
        fetchImpl,
      }),
    ).toBe(scene);
    expect(asked).toBe(false);
  });

  it('keepsTheCard', () => {
    expect(
      keepsTheCard('Launch day in yellow', 'A title card "Launch day" in yellow letters.'),
    ).toBe(true);
    expect(keepsTheCard('Launch day in yellow', 'A title card "Launch" in yellow letters.')).toBe(
      false,
    );
    expect(keepsTheCard('Launch day', 'a glowing launch scene over the sea')).toBe(false);
  });
});

describe('the cleaner unwraps a whole-line quote, never the quoted words inside', () => {
  it('strips marks around the whole answer', () => {
    expect(unwrapQuotes('"A red fox asleep in grass."')).toBe('A red fox asleep in grass.');
    expect(unwrapQuotes('“A red fox asleep in grass.”')).toBe('A red fox asleep in grass.');
    expect(unwrapQuotes("'A fox's den at dusk'")).toBe("A fox's den at dusk");
    expect(unwrapQuotes('"A title card "Tidewell" in teal"')).toBe(
      'A title card "Tidewell" in teal',
    );
  });

  it('keeps marks that belong to quoted words at either end', () => {
    for (const s of [
      'A title card in teal: "Tidewell"',
      '"Tidewell" rising in, in teal letters',
      '"Launch day" rising in, then "Doors open at nine"',
      'a neon sign that says "OPEN"',
    ]) {
      expect(unwrapQuotes(s), s).toBe(s);
      expect(cleanEnhanced(s, 'a sign', 80), s).toBe(s);
    }
  });

  it('drops a lone mark left by a clipped answer', () => {
    expect(unwrapQuotes('"A red fox asleep in grass')).toBe('A red fox asleep in grass');
  });
});
