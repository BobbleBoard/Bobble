/**
 * THE PROMPT ENHANCER.
 *
 * "a fox in grass" is a perfectly good thought and a poor prompt. Every
 * generator in this app has a house style — described at length in
 * `prompt-guidelines.ts` — and the gap between what someone types and what the
 * model wants is most of the difference between a disappointing first result
 * and a good one. That gap is the kind of small, mechanical, well-specified
 * rewrite a TINY language model does well, in under a second, on the machine
 * that is about to spend two minutes rendering.
 *
 * ## Why a small model and not the chat model
 *
 * Two reasons. The chat model is often 27B and is holding a conversation: a
 * background call that does not share its prefix evicts the KV slot, and the
 * user's NEXT message then pays a full cold prefill — measured repeatedly in
 * this codebase as the single worst latency regression available. And the task
 * genuinely does not need the big model. So the enhancer points at whatever
 * `PI_DESKTOP_ENHANCER_BASE_URL` names, falls back to the running local server
 * when that is unset, and stays off entirely when neither exists.
 *
 * ## Why the output is sanitised rather than trusted
 *
 * A 2B model asked for one line will sometimes hand back "Sure! Here's an
 * enhanced version:" followed by the line, a bulleted rationale, and an offer to
 * try again. All of that would be sent verbatim to a diffusion model as though
 * it were part of the picture. {@link cleanEnhanced} is the seatbelt: it is pure,
 * it is tested, and if what comes back is not usable it returns the user's own
 * words rather than a worse version of them. An enhancer that can quietly make
 * the prompt WORSE is not a feature you can leave on by default.
 */
import { canEnhance, type EnhanceKind, guidelineFor } from './prompt-guidelines';

export type { EnhanceKind };
export { canEnhance };

/** Where the small model lives. Null when nothing is available to ask. */
export interface EnhancerEndpoint {
  /** OpenAI-compatible base, already ending in `/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

/**
 * THE INSTRUCTION.
 *
 * Written the way it is after testing against a 2B with generation switched off
 * — the failure modes it is shaped around are all things that model actually
 * did:
 *
 *   - It answered the prompt instead of rewriting it ("Sure, I can help you make
 *     an image of a fox!"), so the first line says what the OUTPUT is.
 *   - It invented a different subject when the input was two words, so the
 *     rewrite is framed as adding detail to the user's idea, never replacing it.
 *   - It wrapped the line in quotes or **bold**, so the format is stated plainly
 *     and the cleaner strips them anyway.
 *   - It explained its choices afterwards, so "nothing else" is its own line
 *     rather than a clause buried in a paragraph.
 *
 * The house rules and the worked example come from the guideline for the target
 * model — the one part of this that changes per generator.
 */
export function enhanceSystemPrompt(kind: EnhanceKind, model?: string): string {
  const g = guidelineFor(kind, model);
  const subject =
    g.dialect === 'music'
      ? 'a piece of music'
      : g.dialect === 'sfx'
        ? 'a sound effect'
        : g.dialect === 'video'
          ? 'a short video clip'
          : 'an image';
  return [
    `You rewrite short descriptions into prompts for a model that generates ${subject}.`,
    '',
    'You are not talking to the user and you are not making the thing yourself. You output the rewritten prompt and nothing else — no preamble, no quotes, no markdown, no explanation, no options, no follow-up question.',
    '',
    "Keep the user's idea exactly. Add the detail they left out; never change the subject, swap it for a different one, or add a subject they did not mention.",
    '',
    'House rules for this model:',
    ...g.rules.map((r) => `- ${r}`),
    '',
    `Stay under ${g.maxWords} words.`,
    '',
    'Example',
    `Input: ${g.example.from}`,
    `Output: ${g.example.to}`,
  ].join('\n');
}

/**
 * Strip everything a small model wraps its answer in, and decide whether what is
 * left is worth using.
 *
 * Returns the ORIGINAL when the answer is unusable, so a caller can always send
 * the result straight to the generator. The checks, in order of how often they
 * fire in practice: a chatty lead-in line, surrounding quotes or bold, a
 * trailing rationale after a blank line, an answer that is somehow shorter than
 * the input (the model summarised rather than expanded), and the word cap.
 */
export function cleanEnhanced(raw: string, original: string, maxWords: number): string {
  let text = raw.trim();
  if (text === '') return original;

  // Reasoning models leak a <think> block even when asked not to.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // A lead-in line ending in a colon ("Here is the enhanced prompt:"), then the
  // real answer below it. Only dropped when something follows, so a legitimate
  // one-line answer containing a colon survives.
  const lines = text.split('\n');
  if (lines.length > 1 && /^[^.!?]{0,80}:\s*$/.test(lines[0] ?? '')) {
    text = lines.slice(1).join('\n').trim();
  }

  // The rationale after a blank line, or a markdown rule, or a bulleted list of
  // "changes I made". The prompt itself is the first paragraph.
  const para = text.split(/\n\s*\n/)[0] ?? text;
  text = para.trim();
  text = text
    .split('\n')
    .filter((l) => !/^\s*(?:[-*•]|\d+\.)\s/.test(l))
    .join(' ')
    .trim();

  // Markdown and quotation the model added around the whole line.
  text = text.replace(/^\*\*(.*)\*\*$/s, '$1').trim();
  text = text.replace(/^["'“”'']+|["'“”'']+$/g, '').trim();
  text = text
    .replace(/^(?:prompt|output|enhanced prompt|rewritten prompt)\s*[:\-—]\s*/i, '')
    .trim();

  if (text === '') return original;

  // It refused, or it answered the user instead of rewriting for the generator.
  // Written loosely on purpose — a refusal that slips through is sent verbatim
  // to a diffusion model, which will happily illustrate the word "sorry".
  if (
    /^(?:i(?:'m| am)?\s+(?:sorry|cannot|can't|am unable|not able|apologi[sz]e)|sorry|unfortunately|as an ai)\b/i.test(
      text,
    )
  ) {
    return original;
  }
  // It asked a question back rather than producing a prompt.
  if (text.endsWith('?') && text.split(/\s+/).length < 25) return original;

  // A rewrite that is shorter than what it was given has removed the user's
  // detail rather than adding to it — the one outcome that is strictly worse
  // than doing nothing.
  const words = text.split(/\s+/).filter((w) => w !== '');
  const originalWords = original
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length < originalWords.length) return original;

  // The cap is a hard stop, cut at a sentence where possible so the tail is not
  // a fragment.
  if (words.length > maxWords) {
    const cut = words.slice(0, maxWords).join(' ');
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text =
      lastStop > cut.length * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.replace(/[,;:]$/, '')}.`;
  }
  return text;
}

export interface EnhanceOptions {
  readonly kind: EnhanceKind;
  readonly model?: string;
  readonly prompt: string;
  readonly endpoint: EnhancerEndpoint;
  readonly signal?: AbortSignal;
  /** Overridable so tests do not need a network. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Rewrite one prompt. Never throws and never returns worse than it was given:
 * every failure path — no endpoint, a timeout, an HTTP error, junk output —
 * returns the user's own text. A prompt enhancer that can block the Generate
 * button is not worth having.
 */
export async function enhancePrompt(opts: EnhanceOptions): Promise<string> {
  const { kind, model, prompt, endpoint } = opts;
  const trimmed = prompt.trim();
  if (trimmed === '' || !canEnhance(kind, model)) return prompt;

  const g = guidelineFor(kind, model);
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);

  try {
    const res = await doFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey !== undefined ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: enhanceSystemPrompt(kind, model) },
          { role: 'user', content: trimmed },
        ],
        // Low but not zero: the rewrite should be predictable, and a greedy
        // decode on a small model tends to repeat the example back.
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: Math.max(96, g.maxWords * 4),
        stream: false,
        // llama.cpp: keep a reasoning model from spending the whole budget
        // thinking before a one-line answer. Ignored by servers that do not know it.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) return prompt;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = body.choices?.[0]?.message?.content ?? '';
    return cleanEnhanced(raw, trimmed, g.maxWords);
  } catch {
    return prompt;
  }
}
