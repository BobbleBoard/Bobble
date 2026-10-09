/**
 * The quick panel's thread, as turns: each user message, then everything the
 * assistant did in answer to it (its messages and their tool results) as ONE
 * group — the shape the main chat draws, read from the same pi store.
 *
 * Pure, so the grouping and the reply text that "Copy" and "Replace selection"
 * use are testable.
 */
import type { AssistantMsg, ChatMsg, NoticeMsg, ToolResultMsg, UserMsg } from '@pi-desktop/engine';

export type QuickTurn =
  | { readonly kind: 'user'; readonly msg: UserMsg }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly group: AssistantMsg[];
      readonly results: ReadonlyMap<string, ToolResultMsg>;
      /** The user message this answers, when there is one. */
      readonly answers: string | null;
    }
  | { readonly kind: 'notice'; readonly msg: NoticeMsg };

export function quickTurns(messages: readonly ChatMsg[]): QuickTurn[] {
  const out: QuickTurn[] = [];
  let group: AssistantMsg[] = [];
  let results = new Map<string, ToolResultMsg>();
  let answers: string | null = null;
  const flush = (): void => {
    if (group.length === 0) return;
    out.push({ kind: 'assistant', id: group[0]?.id ?? 'a', group, results, answers });
    group = [];
    results = new Map();
  };
  for (const m of messages) {
    switch (m.kind) {
      case 'user':
        flush();
        out.push({ kind: 'user', msg: m });
        answers = m.id;
        break;
      case 'assistant':
        group.push(m);
        break;
      case 'toolResult':
        results.set(m.toolCallId, m);
        break;
      case 'notice':
        flush();
        out.push({ kind: 'notice', msg: m });
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/** The words of a reply — every text block, in order, as one string. */
export function replyText(group: readonly AssistantMsg[]): string {
  return group
    .flatMap((m) => m.blocks)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** A title for the panel's history, from the first thing asked. */
export function threadTitle(messages: readonly ChatMsg[]): string {
  const first = messages.find((m): m is UserMsg => m.kind === 'user');
  const text = (first?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return 'Quick question';
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}
