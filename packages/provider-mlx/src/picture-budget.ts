/**
 * A PICTURE IN A CONVERSATION TOO LONG FOR THE VISION LANE IS DESCRIBED, NOT
 * LOST — and the turn goes on.
 *
 * rapid-mlx's vision lane prefills a request that carries a picture in ONE
 * pass, not in chunks, and admits at most 8,192 prompt tokens for the WHOLE
 * conversation (`--vision-prefill-token-budget`). MEASURED 2026-09-25 on this
 * Mac (the 4B the app runs, one 1280×900 page picture): 6,786 tokens fine,
 * 10,541 fine, ~14,000 ran the GPU out of memory — so the budget is a memory
 * guard, and lifting it trades a refusal for a crash. And a harness chat's
 * system prompt and tools alone are ~6,500 tokens: a picture `present` hands
 * back after the model has written a page arrives in a conversation of 12,000,
 * and the turn ended in "The local model server returned an error".
 *
 * So when the conversation is too long to carry its pictures, each picture is
 * DESCRIBED by the same model in a request of its own (the picture and one
 * question, ~1,800 tokens — well inside the budget), and the description takes
 * the picture's place. A picture is described once: the next turn sends the
 * same picture again, and the description is remembered.
 */
import { createHash } from 'node:crypto';

/** rapid-mlx's default vision budget (max of 8,192 and its prefill step). */
export const RAPID_MLX_VISION_BUDGET = 8192;

/**
 * A picture's cost in prompt tokens, rounded up: Qwen's vision tower cuts a
 * ~1 MP picture into 28-px patches merged 2×2, ~1,300 tokens, plus its markers.
 */
const PICTURE_TOKENS = 1600;

/** Characters per token for the estimate — code, HTML and JSON tokenise densely. */
const CHARS_PER_TOKEN = 3.5;

interface Part {
  readonly type?: string;
  readonly text?: string;
  readonly image_url?: { readonly url?: string };
}
interface Message {
  readonly role?: string;
  readonly content?: string | readonly Part[] | null;
  readonly [key: string]: unknown;
}
interface Body {
  readonly messages?: readonly Message[];
  readonly tools?: unknown;
  readonly [key: string]: unknown;
}

const isPicture = (p: Part): boolean =>
  p.type === 'image_url' && typeof p.image_url?.url === 'string';

/** Every picture's URL in the request, in order, each once. */
export function picturesIn(body: Body): string[] {
  const out: string[] = [];
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as readonly Part[]) {
      const url = p.image_url?.url;
      if (isPicture(p) && url !== undefined && !out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** The request's prompt, estimated in tokens (text, tool schemas, pictures). */
export function estimatePromptTokens(body: Body): number {
  let chars = body.tools === undefined ? 0 : JSON.stringify(body.tools).length;
  let pictures = 0;
  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content as readonly Part[]) {
        if (isPicture(p)) pictures += 1;
        else chars += p.text?.length ?? 0;
      }
    }
    // A tool call's arguments are prompt too (a written page lives there).
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (calls !== undefined) chars += JSON.stringify(calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + pictures * PICTURE_TOKENS;
}

const described = new Map<string, string>();
const keyOf = (url: string): string => createHash('sha1').update(url).digest('hex');

/** How a described picture reads in the conversation. */
export function describedPicture(description: string | null): string {
  return description !== null && description.trim() !== ''
    ? `[A picture — shown to you as a description, because this conversation is too long to carry it: ${description.trim()}]`
    : '[A picture was here; this conversation is too long to show it.]';
}

/**
 * The request as the vision lane can take it: unchanged when it fits the
 * budget, otherwise every picture replaced by its description.
 * `describe` asks the model about ONE picture; it may answer null.
 */
export async function fitPicturesToVisionBudget(
  body: Body,
  opts: {
    readonly describe: (url: string) => Promise<string | null>;
    readonly budget?: number;
  },
): Promise<Body> {
  const pictures = picturesIn(body);
  if (pictures.length === 0) return body;
  if (estimatePromptTokens(body) <= (opts.budget ?? RAPID_MLX_VISION_BUDGET)) return body;
  const text = new Map<string, string>();
  for (const url of pictures) {
    const key = keyOf(url);
    let d = described.get(key) ?? null;
    if (d === null) {
      d = await opts.describe(url).catch(() => null);
      if (d !== null && d.trim() !== '') described.set(key, d);
    }
    text.set(url, describedPicture(d));
  }
  return {
    ...body,
    messages: (body.messages ?? []).map((m) =>
      Array.isArray(m.content)
        ? {
            ...m,
            content: (m.content as readonly Part[]).map((p) =>
              isPicture(p)
                ? { type: 'text', text: text.get(p.image_url?.url ?? '') ?? describedPicture(null) }
                : p,
            ),
          }
        : m,
    ),
  };
}

/** Forget every description (tests). */
export function forgetDescribedPictures(): void {
  described.clear();
}
