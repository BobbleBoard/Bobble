/**
 * THE CONVERSATION WITH VFIG — figures to SVG code, as llama-server sees it.
 *
 * VFIG-4B (XunmeiLiu/VFIG-4B, a Qwen3-VL fine-tune) turns a figure — a
 * diagram, a chart, a labelled physics setup — into SVG CODE: real `<text>`,
 * real `<rect>`s and arrows, so the words survive and the file can be edited.
 * MEASURED 2026-09-25 (the SVG bake-off, UD-Q6_K_XL): the kinetic-theory
 * figure, a GAN diagram (SSIM 0.83), a bar chart and a logo came back as
 * faithful, editable SVG — where OmniSVG, which draws paths and cannot write
 * text, has nothing to offer. It also EDITS an SVG it is shown (3.5 of 4
 * edits right). Its one failure was the limit: two 48-icon grids ran out of
 * their 8,192 tokens mid-file. So here there is no token limit — the context
 * bounds a reply, and a reply that starts repeating itself is cut where the
 * repetition began (`textLoopStart`), then closed into a valid file
 * (`svgFromText`).
 *
 * Pure: what to send, and how to read what comes back. The server lives in
 * the app.
 */

/** The model card's instruction, word for word. */
export const VFIG_FIGURE_PROMPT = 'Convert this figure into valid SVG code.';

export interface VfigMessage {
  readonly role: 'user';
  readonly content:
    | string
    | ReadonlyArray<
        | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
        | { readonly type: 'text'; readonly text: string }
      >;
}

export interface VfigRequest {
  readonly messages: readonly VfigMessage[];
  /** Greedy, as the model card decodes. */
  readonly temperature: 0;
  /** No limit: until the model ends the file or the context is full. */
  readonly n_predict: -1;
  readonly stream: boolean;
  readonly cache_prompt: false;
}

export type VfigInput =
  | { readonly imageBase64: string; readonly mimeType?: string }
  | { readonly prompt: string }
  | { readonly svg: string; readonly instruction: string };

/** The editing turn the bake-off measured: the file, the change, "the complete edited SVG only". */
export function vfigEditText(svg: string, instruction: string): string {
  return `Here is an SVG:\n\`\`\`svg\n${svg.trim()}\n\`\`\`\nEdit it: ${instruction.trim()}\nReturn the complete edited SVG code only.`;
}

export function buildVfigRequest(input: VfigInput, stream = true): VfigRequest {
  let content: VfigMessage['content'];
  if ('imageBase64' in input) {
    content = [
      {
        type: 'image_url',
        image_url: { url: `data:${input.mimeType ?? 'image/png'};base64,${input.imageBase64}` },
      },
      { type: 'text', text: VFIG_FIGURE_PROMPT },
    ];
  } else if ('svg' in input) {
    content = vfigEditText(input.svg, input.instruction);
  } else {
    content = `Generate valid SVG code for: ${input.prompt.trim()}`;
  }
  return {
    messages: [{ role: 'user', content }],
    temperature: 0,
    n_predict: -1,
    stream,
    cache_prompt: false,
  };
}

/**
 * WHERE A RUNAWAY REPETITION BEGINS in streamed text, or -1.
 *
 * Greedy decoding can fall into a cycle — the same `<rect …/>` line, or the
 * same run of coordinates, forever. The tail is checked for a block of `p`
 * characters (8 to 800) that repeats back to back for at least `minSpan`
 * characters and `minRepeats` copies; the answer is where the first copy
 * starts, so everything before it is kept. A figure's legitimately similar
 * lines differ in their numbers, so they never repeat exactly.
 */
export function textLoopStart(
  text: string,
  {
    minRepeats = 8,
    minSpan = 1200,
    maxPeriod = 800,
  }: { minRepeats?: number; minSpan?: number; maxPeriod?: number } = {},
): number {
  const n = text.length;
  for (let p = 8; p <= maxPeriod; p += 1) {
    const span = Math.max(minSpan, p * minRepeats);
    if (span + p > n) break;
    // The last `span` characters equal the ones `p` before them: a period-p tail.
    let same = true;
    for (let i = n - span; i < n; i += 1) {
      if (text.charCodeAt(i) !== text.charCodeAt(i - p)) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    // Walk back to where the repetition started.
    let start = n - span - p;
    while (start > 0 && text.charCodeAt(start - 1) === text.charCodeAt(start - 1 + p)) start -= 1;
    return start;
  }
  return -1;
}

const DRAWS = /<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/g;

/**
 * A REPLY THAT HAS STOPPED DRAWING — where it stalled, or -1. MEASURED
 * (2026-09-25, VFIG with no token limit, a 48-icon grid): 32,400 tokens and
 * 17 minutes, most of it unique <linearGradient> definitions — no exact
 * repetition for textLoopStart to find — and three icons drawn at the end.
 * The tail is stalled when it holds many tags and not one that draws; a long
 * run of path data has few tags, so it is never taken for a stall. The answer
 * is where the stalled stretch begins.
 */
export function textStallStart(
  text: string,
  { window = 8000, minTags = 24 }: { window?: number; minTags?: number } = {},
): number {
  if (text.length < window) return -1;
  const tail = text.slice(text.length - window);
  const tags = (tail.match(/<[A-Za-z][\w:-]*/g) ?? []).length;
  if (tags < minTags || DRAWS.test(tail)) {
    DRAWS.lastIndex = 0;
    return -1;
  }
  DRAWS.lastIndex = 0;
  // Back to the last element that drew anything (or the start of the stalled stretch).
  let last = -1;
  for (const m of text.slice(0, text.length - window).matchAll(DRAWS)) last = m.index ?? last;
  if (last < 0) return text.length - window;
  const end = text.indexOf('>', last);
  return end < 0 ? text.length - window : end + 1;
}

const VOID = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'stop',
  'use',
  'image',
]);

/**
 * The SVG in a reply, as a file that parses: from `<svg` to its `</svg>`; or,
 * when the reply was cut short, up to the last whole tag, with every element
 * still open closed in order. `complete` says which.
 */
export function svgFromText(text: string): { svg: string | null; complete: boolean } {
  const a = text.indexOf('<svg');
  if (a < 0) return { svg: null, complete: false };
  const end = text.lastIndexOf('</svg>');
  if (end > a) return { svg: text.slice(a, end + 6), complete: true };
  // Cut short: drop a half-written tag, then close what is open.
  let body = text.slice(a);
  const lastClose = body.lastIndexOf('>');
  const lastOpen = body.lastIndexOf('<');
  if (lastOpen > lastClose) body = body.slice(0, lastOpen);
  if (!body.includes('>')) return { svg: null, complete: false };
  const open: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (name === undefined) continue;
    if (closing === '/') {
      const at = open.lastIndexOf(name);
      if (at >= 0) open.splice(at);
    } else if (selfClosing !== '/' && !(VOID.has(name) && /\/\s*>$/.test(m[0]))) {
      open.push(name);
    }
  }
  // Text inside an open <text> or <tspan> is fine as it is; each open element is closed.
  const closing = open
    .reverse()
    .map((n) => `</${n}>`)
    .join('');
  return { svg: `${body.trimEnd()}${closing}`, complete: false };
}
