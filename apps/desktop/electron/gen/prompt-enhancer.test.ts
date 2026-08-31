/**
 * The cleaner is the enhancer's seatbelt, so it is the part that is tested
 * exhaustively: everything here is a shape a real small model produced during
 * tuning (`tests/enhance/enhance-probe.mjs`), and the rule that matters is that
 * an unusable answer returns the USER'S text rather than a mangled one.
 */
import { describe, expect, it } from 'vitest';
import { cleanEnhanced, enhancePrompt, enhanceSystemPrompt } from './prompt-enhancer';
import { canEnhance, guidelineFor } from './prompt-guidelines';

const ORIGINAL = 'a fox in grass';
const GOOD =
  'A red fox curled asleep in tall dry grass, low golden evening light raking across the seed heads, shallow depth of field.';

describe('cleanEnhanced', () => {
  it('passes a clean one-line rewrite through untouched', () => {
    expect(cleanEnhanced(GOOD, ORIGINAL, 70)).toBe(GOOD);
  });

  it('drops a chatty lead-in line', () => {
    expect(cleanEnhanced(`Here is the enhanced prompt:\n${GOOD}`, ORIGINAL, 70)).toBe(GOOD);
  });

  it('drops a trailing rationale after a blank line', () => {
    expect(cleanEnhanced(`${GOOD}\n\nI added the light and the lens.`, ORIGINAL, 70)).toBe(GOOD);
  });

  it('drops a bulleted list of changes', () => {
    const raw = `${GOOD}\n- added the light\n- added a lens`;
    expect(cleanEnhanced(raw, ORIGINAL, 70)).toBe(GOOD);
  });

  it('unwraps quotes and bold', () => {
    expect(cleanEnhanced(`**"${GOOD}"**`, ORIGINAL, 70)).toBe(GOOD);
    expect(cleanEnhanced(`“${GOOD}”`, ORIGINAL, 70)).toBe(GOOD);
  });

  it('strips a leading "Prompt:" label', () => {
    expect(cleanEnhanced(`Prompt: ${GOOD}`, ORIGINAL, 70)).toBe(GOOD);
  });

  it('strips a leaked <think> block', () => {
    expect(cleanEnhanced(`<think>the user wants a fox</think>\n${GOOD}`, ORIGINAL, 70)).toBe(GOOD);
  });

  it('returns the original when the model refuses', () => {
    expect(cleanEnhanced("I'm sorry, I can't help with that.", ORIGINAL, 70)).toBe(ORIGINAL);
  });

  it('returns the original when the model asks a question back', () => {
    expect(cleanEnhanced('What style would you like?', ORIGINAL, 70)).toBe(ORIGINAL);
  });

  it('returns the original when the rewrite is shorter than the input', () => {
    // Summarising instead of expanding is the one outcome strictly worse than
    // doing nothing at all.
    expect(cleanEnhanced('a fox', 'a red fox asleep in tall grass', 70)).toBe(
      'a red fox asleep in tall grass',
    );
  });

  it('returns the original for an empty answer', () => {
    expect(cleanEnhanced('   ', ORIGINAL, 70)).toBe(ORIGINAL);
  });

  it('cuts at a sentence boundary when over the word cap', () => {
    const long = `${GOOD} ${'and more detail '.repeat(40)}`;
    const out = cleanEnhanced(long, ORIGINAL, 25);
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(out.endsWith('.')).toBe(true);
  });
});

describe('guidelines', () => {
  it('gives speech no dialect, so it can never be enhanced', () => {
    expect(canEnhance('speech')).toBe(false);
    expect(guidelineFor('speech').dialect).toBe('none');
  });

  it('prefers the named model over the job kind', () => {
    // An image job pointed at a video model follows the VIDEO house style: the
    // model is a fact, the kind is only a default.
    expect(guidelineFor('image', 'wan2.1-t2v-1.3b').dialect).toBe('video');
  });

  it('falls back to the kind for a model it has never heard of', () => {
    expect(guidelineFor('image', 'someones-custom-checkpoint').dialect).toBe('image-natural');
  });

  it('names the target medium in the system prompt', () => {
    expect(enhanceSystemPrompt('video')).toContain('short video clip');
    expect(enhanceSystemPrompt('music')).toContain('piece of music');
  });
});

describe('enhancePrompt', () => {
  const endpoint = { baseUrl: 'http://127.0.0.1:1/v1', model: 'tiny' };

  it('never calls out for speech', async () => {
    let called = false;
    const out = await enhancePrompt({
      kind: 'speech',
      prompt: 'Your table is ready.',
      endpoint,
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(out).toBe('Your table is ready.');
  });

  it('returns the original when the endpoint errors', async () => {
    const out = await enhancePrompt({
      kind: 'image',
      prompt: ORIGINAL,
      endpoint,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    expect(out).toBe(ORIGINAL);
  });

  it('returns the original when the request throws', async () => {
    const out = await enhancePrompt({
      kind: 'image',
      prompt: ORIGINAL,
      endpoint,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(out).toBe(ORIGINAL);
  });

  it('sends the guideline for the named model and returns the cleaned answer', async () => {
    let sentSystem = '';
    const out = await enhancePrompt({
      kind: 'image',
      model: 'wan2.1-t2v-1.3b',
      prompt: ORIGINAL,
      endpoint,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: { role: string; content: string }[];
        };
        sentSystem = body.messages[0]?.content ?? '';
        return new Response(
          JSON.stringify({ choices: [{ message: { content: `Here you go:\n${GOOD}` } }] }),
        );
      }) as unknown as typeof fetch,
    });
    expect(sentSystem).toContain('short video clip');
    expect(out).toBe(GOOD);
  });
});
