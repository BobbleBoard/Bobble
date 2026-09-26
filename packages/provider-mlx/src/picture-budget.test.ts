/**
 * A picture in a conversation too long for rapid-mlx's vision lane becomes
 * its description (picture-budget.ts). MEASURED 2026-09-25: the lane admits
 * 8,192 prompt tokens with a picture, and ~14,000 ran the GPU out of memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  estimatePromptTokens,
  fitPicturesToVisionBudget,
  forgetDescribedPictures,
  picturesIn,
} from './picture-budget.js';

const PAGE = 'data:image/png;base64,AAAA';
const OTHER = 'data:image/png;base64,BBBB';
const picture = (url: string) => ({ type: 'image_url', image_url: { url } });
const text = (t: string) => ({ type: 'text', text: t });
const body = (filler: number, ...pics: string[]) => ({
  model: 'q',
  messages: [
    { role: 'system', content: 'x'.repeat(filler) },
    { role: 'user', content: [text('Here is the page.'), ...pics.map(picture)] },
  ],
});

beforeEach(() => forgetDescribedPictures());

describe('picture-budget', () => {
  it('counts text, tool calls, tool schemas and pictures', () => {
    expect(picturesIn(body(0, PAGE, OTHER, PAGE))).toEqual([PAGE, OTHER]);
    const small = estimatePromptTokens(body(350, PAGE));
    const withCall = estimatePromptTokens({
      messages: [
        ...body(350, PAGE).messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { arguments: 'y'.repeat(3500) } }],
        },
      ],
      tools: [{ name: 'write', description: 'z'.repeat(350) }],
    });
    expect(small).toBeGreaterThan(1600);
    expect(withCall - small).toBeGreaterThan(1000);
  });

  it('leaves a request that fits exactly as it was — the picture is sent', async () => {
    const describe = vi.fn(async () => 'never');
    const b = body(1000, PAGE);
    expect(await fitPicturesToVisionBudget(b, { describe })).toBe(b);
    expect(describe).not.toHaveBeenCalled();
  });

  it('describes each picture of a conversation too long to carry it, once', async () => {
    const describe = vi.fn(async (url: string) =>
      url === PAGE ? 'A landing page with a serif title, "Kiln & Co".' : 'A bowl.',
    );
    const long = body(40_000, PAGE, OTHER);
    const out = await fitPicturesToVisionBudget(long, { describe });
    const parts = (out.messages?.[1]?.content ?? []) as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'text']);
    expect(parts[1]?.text).toContain('Kiln & Co');
    expect(parts[1]?.text).toContain('too long to carry it');
    expect(picturesIn(out)).toEqual([]);
    // The next turn sends the same picture again: its description is remembered.
    await fitPicturesToVisionBudget(long, { describe });
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('says a picture was there when it could not be described', async () => {
    const out = await fitPicturesToVisionBudget(body(40_000, PAGE), {
      describe: async () => {
        throw new Error('server busy');
      },
    });
    const parts = (out.messages?.[1]?.content ?? []) as Array<{ text?: string }>;
    expect(parts[1]?.text).toBe('[A picture was here; this conversation is too long to show it.]');
  });
});
