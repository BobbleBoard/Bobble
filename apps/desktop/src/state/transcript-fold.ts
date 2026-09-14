/**
 * Pure transcript-fold primitives — the building blocks that turn a stream of
 * StoreSink callbacks into a `ChatMsg[]`. Shared by the main chat store
 * (pi-slice) and the child-agent store (child-agent-store) so a subagent/role
 * renders through the EXACT same fold as the main chat, not a parallel copy.
 */
import type {
  AssistantMessage,
  AssistantMsg,
  ChatMsg,
  ContentBlock,
  ToolResultMsg,
} from '@pi-desktop/engine';

/** Map the assistant message with `id`, leaving every other row untouched. */
export function mutateAssistant(
  messages: ChatMsg[],
  id: string,
  mutate: (msg: AssistantMsg) => AssistantMsg,
): ChatMsg[] {
  return messages.map((m) => (m.kind === 'assistant' && m.id === id ? mutate(m) : m));
}

/** Append a text/thinking delta onto the assistant's LAST block of that kind,
 * or start a new block — the token-append that produces the streaming look. */
export function appendOrMergeBlock(
  messages: ChatMsg[],
  id: string,
  kind: 'text' | 'thinking',
  delta: string,
): ChatMsg[] {
  return mutateAssistant(messages, id, (m) => {
    const blocks = [...m.blocks];
    const last = blocks[blocks.length - 1];
    if (kind === 'text') {
      if (last?.type === 'text')
        blocks[blocks.length - 1] = { type: 'text', text: last.text + delta };
      else blocks.push({ type: 'text', text: delta });
    } else {
      if (last?.type === 'thinking') {
        blocks[blocks.length - 1] = { type: 'thinking', thinking: last.thinking + delta };
      } else {
        blocks.push({ type: 'thinking', thinking: delta });
      }
    }
    return { ...m, blocks };
  });
}

/**
 * The streamed text blocks, with their text taken from pi's FINAL message where
 * the two differ. What streamed is what the model typed; what turn_end carries
 * is what the provider settled on — and a provider may rewrite a text block
 * after streaming it (rung 0 takes a written tool call out of the text once it
 * has become a real call, so the thread shows an activity row, not raw
 * `<function …>` markup). Text blocks pair up in order; when the counts differ
 * the stream is kept as it was (nothing here guesses a mapping).
 */
export function adoptFinalText(
  blocks: ContentBlock[],
  content: AssistantMessage['content'] | undefined,
): ContentBlock[] {
  if (content === undefined) return blocks;
  const finalTexts = content.filter((c) => c.type === 'text').map((c) => c.text);
  const finalThoughts = content
    .filter((c) => c.type === 'thinking')
    .map((c) => (c as { thinking: string }).thinking);
  const streamedTexts = blocks.filter((b) => b.type === 'text').length;
  const streamedThoughts = blocks.filter((b) => b.type === 'thinking').length;
  /*
   * A THOUGHT THAT TURNED OUT TO BE THE REPLY. The model wrote its answer into
   * the think block the template opened and ended without closing it; the
   * provider settles that into a text block (settle-reply.ts). What streamed
   * was a thought and nothing else, so the counts can never pair up — the
   * settled shape is taken whole, or the thread keeps showing an empty turn
   * with the answer folded inside "Thought for 4s".
   */
  if (
    streamedThoughts > 0 &&
    streamedTexts === 0 &&
    finalThoughts.length === 0 &&
    finalTexts.length > 0 &&
    !blocks.some((b) => b.type === 'toolCall')
  ) {
    return finalTexts.map((text) => ({ type: 'text', text }));
  }
  const texts = finalTexts.length === streamedTexts;
  // Thoughts too: a provider that strips an engine's notice out of a thought
  // (rapid-mlx's cut-mid-think sentinel) settles the block the same way.
  const thoughts = finalThoughts.length === streamedThoughts;
  if (!texts && !thoughts) return blocks;
  let i = 0;
  let j = 0;
  let changed = false;
  const out = blocks.map((b) => {
    if (b.type === 'text' && texts) {
      const text = finalTexts[i++] ?? b.text;
      if (text === b.text) return b;
      changed = true;
      return { ...b, text };
    }
    if (b.type === 'thinking' && thoughts) {
      const thinking = finalThoughts[j++] ?? b.thinking;
      if (thinking === b.thinking) return b;
      changed = true;
      return { ...b, thinking };
    }
    return b;
  });
  return changed ? out : blocks;
}

/** Insert-or-replace a tool result keyed by its (assistant-scoped) row id —
 * providers reuse toolCallIds across runs, so match on `id`, never toolCallId. */
export function upsertToolResultMsg(messages: ChatMsg[], result: ToolResultMsg): ChatMsg[] {
  const existing = messages.findIndex((m) => m.kind === 'toolResult' && m.id === result.id);
  return existing >= 0
    ? messages.map((m, i) => (i === existing ? result : m))
    : [...messages, result];
}
