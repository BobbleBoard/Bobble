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
 *
 * NOT ONLY AFTER A TOOL. MEASURED (Gemma 4 12B, a student's third question
 * about the area of a circle, 2026-10-01): no tool ran, the server counted 548
 * tokens out and none of them reached the reply — the chat showed the question
 * with nothing under it. A question the person asked is something to answer
 * for, whatever the turn ran. What the turn answered for is the last message
 * that asked: when that was the harness's own private steer (a check it runs
 * and asks to be fixed silently), the silence was asked for.
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

/** How a turn ended without a word: after which failure, and whether any tool ran. */
export interface SilentEnd {
  /** The last tool result that failed (its tool and first line), or ''. */
  readonly failed: string;
  /** Whether the turn ran anything at all — a turn that only thought did not. */
  readonly ran: boolean;
}

/**
 * The turn's end, if it said nothing to the person. Null when the turn said
 * something, was stopped, ended in an error the person already sees, answered
 * the harness's own private steer (`isPrivateSteer`), or had nothing to answer
 * for at all (no question and no tool).
 */
export function silentEnd(
  messages: readonly unknown[],
  isPrivateSteer: (text: string) => boolean = () => false,
): SilentEnd | null {
  let lastAssistant: MessageLike | undefined;
  let asked: MessageLike | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as MessageLike;
    if (m?.role === 'assistant' && lastAssistant === undefined) lastAssistant = m;
    if (m?.role === 'user') {
      asked = m;
      break;
    }
  }
  if (lastAssistant === undefined) return null;
  if (lastAssistant.stopReason === 'aborted' || lastAssistant.stopReason === 'error') return null;
  if (textOf(lastAssistant.content).trim() !== '') return null;
  if (asked !== undefined && isPrivateSteer(textOf(asked.content).trim())) return null;
  const results = (messages as MessageLike[]).filter((m) => m?.role === 'toolResult');
  // Nothing ran: an empty reply to a question is still an empty reply.
  if (results.length === 0) return asked !== undefined ? { failed: '', ran: false } : null;
  const failedResult = [...results].reverse().find((m) => m.isError === true);
  if (failedResult === undefined) return { failed: '', ran: true };
  const tool =
    typeof failedResult.toolName === 'string' ? failedResult.toolName : 'the last command';
  const first = textOf(failedResult.content)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return { failed: `${tool} failed: ${(first ?? '').slice(0, 240)}`, ran: true };
}

export function silentEndNudge(end: SilentEnd): string {
  if (!end.ran) {
    return (
      'Your turn ended without a word to the user. They are looking at an empty reply to ' +
      'what they just asked. Answer them now.'
    );
  }
  const after = end.failed !== '' ? `, after ${end.failed}` : '';
  return (
    `Your turn ended without a word to the user${after}. They are looking at an empty reply. ` +
    'Carry on: do what that result says, finish the work, and tell them in a sentence or two what ' +
    'you made — or, if you cannot, say plainly what went wrong.'
  );
}

/**
 * After the loop guard stops a turn: the person asked something and the chat
 * shows "Done" over nothing. What the model is told once it is idle — the
 * reason it was stopped, and to answer in words without the tool it was stuck on.
 */
export function loopAbortNudge(reason: string): string {
  return (
    `You were stopped: ${reason}. Do not run another tool for this. Answer what the user ` +
    'asked now, in plain words — and if something you tried did not work, say so in one sentence.'
  );
}
