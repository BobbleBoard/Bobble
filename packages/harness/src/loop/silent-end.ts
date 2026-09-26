/**
 * A TURN THAT ENDS WITHOUT A WORD TO THE PERSON.
 *
 * MEASURED (the maths suite, qwen3.5-4b, 2026-09-26): asked for simple
 * harmonic motion "with an animation of a mass on a spring", the model ran
 * `math` once, was told its spec had neither a plot nor a figure (with two
 * examples), thought for 23 seconds — and the turn ended there. The chat
 * showed "1 command failed, thought for 23s" and nothing else. No answer, no
 * page, no word of what went wrong.
 *
 * The four nudges beside this one catch a menu handed back, a reply cut off at
 * the output limit, a checklist left unfinished and a promise of a next step.
 * None sees the plainest failure: an empty reply. Stop (an aborted turn) is
 * the person choosing silence, and is left alone. Once per session, like its
 * neighbours.
 */

interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly isError?: unknown;
  readonly toolName?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const b = c as { type?: unknown; text?: unknown };
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('\n');
}

/**
 * The turn's end, if it said nothing to the person: the last tool result that
 * failed (its tool and first line), or an empty string when none did. Null
 * when the turn said something, was stopped, or did nothing at all.
 */
export function silentEnd(messages: readonly unknown[]): { failed: string } | null {
  let lastAssistant: MessageLike | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as MessageLike;
    if (m?.role === 'assistant') {
      lastAssistant = m;
      break;
    }
  }
  if (lastAssistant === undefined) return null;
  if (lastAssistant.stopReason === 'aborted' || lastAssistant.stopReason === 'error') return null;
  if (textOf(lastAssistant.content).trim() !== '') return null;
  // Something was done this turn — a tool ran — or there is nothing to answer for.
  const results = (messages as MessageLike[]).filter((m) => m?.role === 'toolResult');
  if (results.length === 0) return null;
  const failedResult = [...results].reverse().find((m) => m.isError === true);
  if (failedResult === undefined) return { failed: '' };
  const tool =
    typeof failedResult.toolName === 'string' ? failedResult.toolName : 'the last command';
  const first = textOf(failedResult.content)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return { failed: `${tool} failed: ${(first ?? '').slice(0, 240)}` };
}

export function silentEndNudge(end: { failed: string }): string {
  const after = end.failed !== '' ? `, after ${end.failed}` : '';
  return (
    `Your turn ended without a word to the user${after}. They are looking at an empty reply. ` +
    'Carry on: do what that result says, finish the work, and tell them in a sentence or two what ' +
    'you made — or, if you cannot, say plainly what went wrong.'
  );
}
