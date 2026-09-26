import { describe, expect, it } from 'vitest';
import {
  buildOmniSvgRequest,
  idsFromCompletion,
  MEDIA_MARKER,
  OMNISVG_SYSTEM_PROMPT,
  textSubtype,
} from './omnisvg-request';

describe('the prompt OmniSVG is sent', () => {
  it('is their text instruction, wrapped in ChatML', () => {
    const r = buildOmniSvgRequest({ prompt: 'a red heart' });
    if (typeof r.prompt !== 'string') throw new Error('a text request sends a string prompt');
    expect(r.prompt).toContain(`<|im_start|>system\n${OMNISVG_SYSTEM_PROMPT}<|im_end|>`);
    expect(r.prompt).toContain('Generate an SVG illustration for: a red heart');
    expect(r.prompt).toContain('- Create complete SVG path commands');
    expect(r.prompt.endsWith('<|im_start|>assistant\n')).toBe(true);
    expect(r.return_tokens).toBe(true);
    expect(typeof r.prompt).toBe('string');
  });

  it('uses their image instruction and the media marker for an image', () => {
    const r = buildOmniSvgRequest({ prompt: 'ignored for images', imageBase64: 'AAAA' });
    /* The picture rides INSIDE the prompt object — the only place llama-server
       reads it (MEASURED: at the top of the body it was ignored, and every
       picture was drawn from the instruction alone). */
    expect(r.prompt).toEqual({
      prompt_string: expect.stringContaining(
        `${MEDIA_MARKER}Generate SVG code that accurately represents this image:`,
      ),
      multimodal_data: ['AAAA'],
    });
    expect(JSON.stringify(r)).not.toContain('ignored for images');
    expect(r).not.toHaveProperty('multimodal_data');
    expect(r.temperature).toBe(0.3);
  });

  /* Their chain (transformers' generate), not llama-server's default one: the
     penalty over the whole sequence, then temperature, top-k, top-p — no min_p. */
  it('samples the way the authors do, for a text prompt and an image alike', () => {
    for (const r of [
      buildOmniSvgRequest({ prompt: 'a red heart' }),
      buildOmniSvgRequest({ imageBase64: 'AAAA' }),
    ]) {
      expect(r.samplers).toEqual(['penalties', 'temperature', 'top_k', 'top_p']);
      expect(r.min_p).toBe(0);
      expect(r.repeat_last_n).toBeGreaterThanOrEqual(2048);
    }
  });

  /* Their task_configs: an icon samples cooler than an illustration. */
  it('picks sampling by their subtype rule', () => {
    expect(textSubtype('a fox icon')).toBe('icon');
    expect(textSubtype('a fox in a forest')).toBe('illustration');
    expect(buildOmniSvgRequest({ prompt: 'a fox icon' }).temperature).toBe(0.5);
    expect(buildOmniSvgRequest({ prompt: 'a fox in a forest' }).temperature).toBe(0.6);
  });

  /* detect_text_subtype, as their inference.py has it: substrings, icon words
     first, then an illustration word or more than 50 characters, else an icon. */
  it('is their detect_text_subtype word for word', () => {
    // Their own icon prompts, with no "icon" in them.
    expect(textSubtype('A red heart shape with smooth curved edges, centered.')).toBe('icon');
    expect(
      textSubtype('A yellow star with five sharp points, simple geometric design, flat color.'),
    ).toBe('icon');
    expect(textSubtype('A black triangle pointing downward, centrally positioned.')).toBe('icon');
    // Substrings, as theirs: "narrow" holds "arrow".
    expect(textSubtype('a narrow road')).toBe('icon');
    // An icon word wins over an illustration word.
    expect(textSubtype('a person inside a circle')).toBe('icon');
    // An illustration word, or length, makes an illustration…
    expect(textSubtype('a cartoon character with a mustache')).toBe('illustration');
    expect(
      textSubtype('An orange thermometer with a circular base represents temperature measurement'),
    ).toBe('illustration');
    // …and a short prompt with neither is an icon.
    expect(textSubtype('a green leaf')).toBe('icon');
  });
});

describe('reading the reply', () => {
  /* The shape of a real reply from the app's llama-server (b10603). */
  it('takes the ids and says how the generation ended', () => {
    const out = idsFromCompletion({
      tokens: [196998, 151939, 151944, 196999],
      stop_type: 'eos',
      timings: { predicted_per_second: 57.7 },
    });
    expect(out).toEqual({ ids: [196998, 151939, 151944, 196999], stop: 'eos', tokPerSec: 57.7 });
  });

  it('reports a missing tokens field as the misconfiguration it is', () => {
    const out = idsFromCompletion({ content: '' } as never);
    expect('error' in out && out.error).toMatch(/return_tokens/);
  });

  it('surfaces a server error verbatim', () => {
    const out = idsFromCompletion({ error: { code: 500, message: 'oom' } });
    expect('error' in out && out.error).toContain('oom');
  });
});
