/**
 * THE REPLY, SETTLED — the final assistant message as the next prompt will
 * carry it and the thread will show it. Shared by the llama.cpp and MLX
 * streams; pure.
 *
 * Three things an engine hands over that are not the reply:
 *
 *  1. The newlines between `</think>` and the answer. rapid-mlx keeps them as
 *     content (MEASURED 2026-09-13: every text block began `\n\n`, a tool-only
 *     turn was `thinking | text "\n\n" | toolCall`; llama.cpp's parser gives
 *     `thinking | toolCall`). Sent back as history they render as
 *     `</think>\n\n` + `\n\n` — bytes the model never generated, so the prefix
 *     cache breaks there and the prompt drifts off-distribution. A text block
 *     that is only whitespace goes for the same reason.
 *  2. An unfinished written tool call. An engine that cuts a reply mid-call
 *     flushes the buffered `<tool_call>` fragment as content (rapid-mlx's
 *     repetition guard did, and the user saw the fragment in the bubble). The text
 *     is cut at the opener; a complete written call is rung 0's to turn into a
 *     real one and is left alone here.
 *  3. A reply that is only a thought. The template opens `<think>\n` for the
 *     model; a small model that decides not to deliberate — after a run of
 *     tool results, most often — writes its answer straight into that slot and
 *     ends without `</think>` (MEASURED 2026-09-13, Qwen3.5-4B on rapid-mlx:
 *     258 tokens of "Here's what it reports about this Mac: …", finish_reason
 *     stop, no content). The engine files it under reasoning and the thread
 *     shows an empty turn — the user's "thought ending whole turns". When the model
 *     ENDED THE TURN ITSELF (`stop`) with nothing but a thought, the thought is
 *     the reply and becomes the text. A reply cut off by the engine (`length`)
 *     keeps its thought as a thought: that one was not finished.
 */
import type { TextContent, ThinkingContent, ToolCall } from '@mariozechner/pi-ai';
import { findToolCallOpener, findWrittenToolCallRegion } from './repair.js';

/** What an assistant reply is made of, as pi types it. */
export type ReplyBlock = TextContent | ThinkingContent | ToolCall;

export function settleReply(
  content: readonly ReplyBlock[],
  finishReason: 'stop' | 'length' | 'toolUse' = 'stop',
): ReplyBlock[] {
  const hasThought = content.some((b) => b.type === 'thinking');
  const hasCall = content.some((b) => b.type === 'toolCall');
  const out: ReplyBlock[] = [];
  for (const block of content) {
    if (block.type !== 'text') {
      out.push(block);
      continue;
    }
    let text = block.text;
    if (hasThought) text = text.replace(/^\n+/, '');
    if (!hasCall) {
      const opener = findToolCallOpener(text);
      if (opener !== -1 && findWrittenToolCallRegion(text) === null) {
        text = text.slice(0, opener).trimEnd();
      }
    }
    if (text.trim().length === 0) continue;
    out.push(text === block.text ? block : { ...block, text });
  }
  if (
    finishReason === 'stop' &&
    !hasCall &&
    !out.some((b) => b.type === 'text') &&
    out.some((b) => b.type === 'thinking' && b.thinking.trim().length > 0)
  ) {
    const thought = out
      .filter((b): b is ThinkingContent => b.type === 'thinking')
      .map((b) => b.thinking)
      .join('')
      .trim();
    return [...out.filter((b) => b.type !== 'thinking'), { type: 'text', text: thought }];
  }
  return out;
}

function textOfBlocks(blocks: readonly ReplyBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/**
 * WHAT SETTLING TOOK, said out loud — a log line, or null when it took nothing
 * worth saying. MEASURED (Gemma 4 12B, 2026-10-01): a reply of 548 tokens
 * settled to nothing at all and the thread showed an empty turn, with no line
 * anywhere saying what the tokens had been. Two cases are named: a reply that
 * ended EMPTY though tokens came out, and text cut at an unfinished written
 * tool call (with the start of what was cut, so the next one can be read).
 */
export function settleNote(
  before: readonly ReplyBlock[],
  after: readonly ReplyBlock[],
  outputTokens: number,
  finishReason: string,
): string | null {
  const was = textOfBlocks(before);
  const now = textOfBlocks(after);
  const cutText = was.trim().length > now.trim().length ? was.slice(now.length).trim() : '';
  const cut = cutText.length > 0 ? ` — cut: ${JSON.stringify(cutText.slice(0, 160))}` : '';
  if (after.length === 0 && outputTokens > 0) {
    return `${outputTokens} tokens out and an empty reply (finish ${finishReason})${cut}`;
  }
  if (cutText.length > 0)
    return `cut ${cutText.length} chars from the reply (finish ${finishReason})${cut}`;
  return null;
}
