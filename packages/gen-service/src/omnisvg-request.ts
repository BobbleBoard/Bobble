/**
 * THE CONVERSATION WITH OMNISVG, as llama-server sees it.
 *
 * Pure: what to send, and how to read what comes back. The process that runs
 * the server lives in the app; this is everything a test can check without one.
 *
 * The prompt shape is the authors' `prepare_inputs` verbatim — same system
 * line, same "Generate an SVG illustration for:" framing, same requirements
 * block — rendered through Qwen2.5's ChatML by hand rather than by the
 * tokenizer's template, because it is four lines and a template pulled from the
 * GGUF would be the one thing here that cannot be read in a test.
 *
 * Sampling is their `task_configs`: icons cooler than illustrations, images
 * cooler still. A prompt is an "icon" by their own `detect_text_subtype` rule.
 */

export const OMNISVG_SYSTEM_PROMPT =
  'You are an expert SVG code generator. \n' +
  'Generate precise, valid SVG path commands that accurately represent the described scene or object.\n' +
  'Focus on capturing key shapes, spatial relationships, and visual composition.';

/** llama.cpp's mtmd marker: where the image's tokens go in the prompt. */
export const MEDIA_MARKER = '<__media__>';

export interface OmniSvgSampling {
  readonly temperature: number;
  readonly top_p: number;
  readonly top_k: number;
  readonly repeat_penalty: number;
}

/** config.yaml `task_configs`, keyed the way their code keys them. */
export const OMNISVG_SAMPLING: Record<'icon' | 'illustration' | 'image', OmniSvgSampling> = {
  icon: { temperature: 0.5, top_p: 0.88, top_k: 50, repeat_penalty: 1.05 },
  illustration: { temperature: 0.6, top_p: 0.9, top_k: 60, repeat_penalty: 1.03 },
  image: { temperature: 0.3, top_p: 0.9, top_k: 50, repeat_penalty: 1.05 },
};

/*
 * Their `detect_text_subtype` (OmniSVG inference.py), word for word: plain
 * substring tests, the icon words first. This read only "icon, logo, symbol,
 * emoji, glyph, badge" as whole words and called everything else an
 * illustration — so "A red heart shape …", "A yellow star …", "A blue arrow
 * …" (their own icon prompts) were sampled warmer and wider than the authors
 * sample them.
 */
const ICON_WORDS = [
  'icon',
  'logo',
  'symbol',
  'badge',
  'button',
  'emoji',
  'glyph',
  'simple',
  'arrow',
  'triangle',
  'circle',
  'square',
  'heart',
  'star',
  'checkmark',
];
const ILLUSTRATION_WORDS = [
  'illustration',
  'scene',
  'person',
  'people',
  'character',
  'man',
  'woman',
  'boy',
  'girl',
  'avatar',
  'portrait',
  'face',
  'head',
  'body',
  'cat',
  'dog',
  'bird',
  'animal',
  'pet',
  'fox',
  'rabbit',
  'sitting',
  'standing',
  'walking',
  'running',
  'sleeping',
  'holding',
  'playing',
  'house',
  'building',
  'tree',
  'garden',
  'landscape',
  'mountain',
  'forest',
  'city',
  'ocean',
  'beach',
  'sunset',
  'sunrise',
  'sky',
];
export function textSubtype(prompt: string): 'icon' | 'illustration' {
  const text = prompt.toLowerCase();
  if (ICON_WORDS.some((w) => text.includes(w))) return 'icon';
  if (ILLUSTRATION_WORDS.some((w) => text.includes(w)) || prompt.length > 50) {
    return 'illustration';
  }
  return 'icon';
}

function chatml(user: string): string {
  return (
    `<|im_start|>system\n${OMNISVG_SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`
  );
}

/** The user turn for a text prompt — their instruction block, verbatim. */
export function textInstruction(prompt: string): string {
  return (
    `Generate an SVG illustration for: ${prompt.trim()}\n        \n` +
    'Requirements:\n' +
    '- Create complete SVG path commands\n' +
    '- Include proper coordinates and colors\n' +
    '- Maintain visual clarity and composition'
  );
}

export interface OmniSvgRequest {
  readonly prompt: string;
  readonly n_predict: number;
  readonly temperature: number;
  readonly top_p: number;
  readonly top_k: number;
  readonly repeat_penalty: number;
  readonly samplers: readonly string[];
  readonly min_p: number;
  readonly repeat_last_n: number;
  /** The ids are the output; the text is empty (the SVG tokens have no text form). */
  readonly return_tokens: true;
  readonly cache_prompt: false;
  /** Base64 images, one per MEDIA_MARKER in the prompt. */
  readonly multimodal_data?: readonly string[];
}

/** Their `MAX_MAX_LENGTH`-ish ceiling; config.yaml's `model.max_length` is 1536. */
export const OMNISVG_MAX_TOKENS = 1536;

/**
 * HOW THE AUTHORS SAMPLE — not llama-server's default chain. Their pipeline is
 * transformers' `generate(do_sample=True, temperature, top_k, top_p,
 * repetition_penalty)`: the penalty over every token in the sequence, then the
 * temperature, then top-k, then top-p, and nothing else. llama-server's
 * defaults differ three ways: the temperature LAST, a min_p of 0.05 on top, and
 * a penalty window of only the last 64 tokens. MEASURED 2026-09-25 on the
 * authors' own prompts through the app's pipeline (17 prompts × 3): with the
 * defaults 22% of the samples ran into a loop — one command of no length, over
 * and over, to the 1,536-id limit — and with this chain 10%. The rest are cut
 * at the loop and drawn again (loopStart, the app's generateSvg).
 */
export const OMNISVG_SAMPLER_CHAIN = {
  samplers: ['penalties', 'temperature', 'top_k', 'top_p'],
  min_p: 0,
  // "Every token in the sequence": the whole context the app gives the server
  // (-c 4096). This llama-server build refuses -1.
  repeat_last_n: 4096,
} as const;

/**
 * The body for `POST /completion`. Text-to-SVG when there is no image;
 * image-to-SVG when there is one (their image instruction, and the prompt —
 * if any — is not used, exactly as their pipeline treats the two tasks).
 */
export function buildOmniSvgRequest(input: {
  readonly prompt?: string;
  readonly imageBase64?: string;
  readonly maxTokens?: number;
}): OmniSvgRequest {
  const n_predict = input.maxTokens ?? OMNISVG_MAX_TOKENS;
  if (input.imageBase64 !== undefined) {
    return {
      prompt: chatml(`${MEDIA_MARKER}Generate SVG code that accurately represents this image:`),
      n_predict,
      ...OMNISVG_SAMPLING.image,
      ...OMNISVG_SAMPLER_CHAIN,
      return_tokens: true,
      cache_prompt: false,
      multimodal_data: [input.imageBase64],
    };
  }
  const prompt = input.prompt ?? '';
  return {
    prompt: chatml(textInstruction(prompt)),
    n_predict,
    ...OMNISVG_SAMPLING[textSubtype(prompt)],
    ...OMNISVG_SAMPLER_CHAIN,
    return_tokens: true,
    cache_prompt: false,
  };
}

/** What a `/completion` reply carries that matters here. */
export interface OmniSvgCompletion {
  readonly tokens?: readonly number[];
  readonly stop_type?: string;
  readonly timings?: { readonly predicted_per_second?: number; readonly predicted_n?: number };
  readonly error?: unknown;
}

/**
 * The ids out of a reply, or an explanation of why there are none.
 *
 * `stop_type` is reported because "eos" and "limit" are different outcomes: a
 * generation that ran into `n_predict` is a shape the model never finished,
 * and the caller may want another sample rather than a truncated file.
 */
export function idsFromCompletion(
  reply: OmniSvgCompletion,
): { ids: number[]; stop: string; tokPerSec: number | null } | { error: string } {
  if (reply.error !== undefined) return { error: `llama-server: ${JSON.stringify(reply.error)}` };
  if (!Array.isArray(reply.tokens)) {
    return { error: 'llama-server returned no token ids — was return_tokens set?' };
  }
  return {
    ids: reply.tokens.map(Number),
    stop: reply.stop_type ?? 'unknown',
    tokPerSec: reply.timings?.predicted_per_second ?? null,
  };
}
