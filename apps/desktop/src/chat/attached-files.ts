/**
 * PULL THE ATTACHMENTS BACK OUT OF A SENT MESSAGE.
 *
 * the user: "pasted content shows literally as 'pasted content' rather than the
 * already-designed paste card."
 *
 * The composer folds text attachments into pi's copy of the message as fenced
 * blocks (`buildAgentMessage`), and echoes only the typed text into the bubble —
 * so live, the card is right. But pi's copy is what lands in the session file,
 * and a chat reopened from disk rebuilds its user bubbles from THAT. His real
 * transcript shows the result: a chat titled
 *
 *     Attached file `pasted content`: ``` we're going to work on the chat…
 *
 * This is the inverse of the fold, so a rebuilt bubble can show the same cards
 * the composer did. Deliberately strict — it matches only the exact shape
 * `buildAgentMessage` writes, so ordinary prose that happens to mention an
 * attachment, or a fenced code block the user typed themselves, is left alone.
 */

/** The name the composer gives a large paste (it names nothing on its own). */
export const PASTED_NAME = 'pasted content';

export interface AttachedFile {
  /**
   * A stable render key. A folded block carries no id, and the body of a sent
   * message never changes — so its position IS its identity here.
   */
  readonly id: string;
  /** The name the composer gave it (`pasted content` for a large paste). */
  readonly name: string;
  /** The file's text, exactly as it was folded in. */
  readonly text: string;
}

export interface SplitMessage {
  /** The attachments, in the order they were folded in. */
  readonly files: readonly AttachedFile[];
  /** What the user actually typed (empty when they attached without typing). */
  readonly text: string;
}

/**
 * A folded block: the header line, then a fenced body. The fence is matched
 * non-greedily up to a closing fence that stands alone on its line, so a
 * pasted snippet containing ``` inside it does not truncate the block.
 */
const BLOCK = /^Attached file `([^`\n]*)`:\n```\n([\s\S]*?)\n```(?:\n\n|\n?$)/;

/** Split a sent message body back into its attachments and the typed text. */
export function splitAttachedFiles(body: string): SplitMessage {
  const files: AttachedFile[] = [];
  let rest = body;
  for (;;) {
    const m = BLOCK.exec(rest);
    if (m === null) break;
    files.push({ id: `${files.length}:${m[1] ?? ''}`, name: m[1] ?? '', text: m[2] ?? '' });
    rest = rest.slice(m[0].length);
  }
  return { files, text: rest };
}

/**
 * The one-line summary of a message for a list (the sidebar's chat title).
 *
 * A title made from the raw body is the folded block — which is how a chat ended
 * up called "Attached file `pasted content`: ```". The typed text is the honest
 * answer. With nothing typed, a NAMED file names the chat, but "pasted content"
 * names nothing, so a paste is summarised by its own first line — which is what
 * the conversation is actually about.
 */
export function messageSummary(body: string): string {
  const { files, text } = splitAttachedFiles(body);
  const typed = text.trim();
  if (typed.length > 0) return typed;
  const first = files[0];
  if (first === undefined) return body.trim();
  if (first.name !== PASTED_NAME) return files.map((f) => f.name).join(', ');
  return firstLine(first.text) || PASTED_NAME;
}

/** The first non-empty line of a block of text. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return '';
}
