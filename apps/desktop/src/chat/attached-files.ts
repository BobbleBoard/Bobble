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
 *
 * AND THE PATH LINES (2026-09-24). A picture, a PDF, a folder now reach the
 * model as a line naming where they are (`Attached folder: /Users/…`), ahead of
 * the folds — see agent-message.ts. They come back out here as cards too; a
 * picture's line comes back as the path of the picture the bubble shows, so
 * clicking it opens the viewer on the real file.
 *
 * Main reads its chat titles with {@link messageSummary} too (fs-handlers.ts) —
 * one parser for the one format, so a title cannot drift from the bubble.
 * Keep this module free of DOM and React for that reason.
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
  /** Where it was on disk, when it was a file there. */
  readonly path?: string;
}

/** A picture, file or folder named to the model by its path. */
export interface AttachedRef {
  /** Position-derived, like {@link AttachedFile.id}. */
  readonly id: string;
  readonly kind: 'image' | 'file' | 'folder';
  readonly path: string;
  /** The path's last segment. */
  readonly name: string;
  /** What the line said it is — `PDF, 2.3 MB`. Absent for a folder. */
  readonly detail?: string;
}

export interface SplitMessage {
  /** The folded text files, in the order they were folded in. */
  readonly files: readonly AttachedFile[];
  /** Files and folders named by path, in order. */
  readonly refs: readonly AttachedRef[];
  /** Pictures named by path, in the order their pixels were sent. */
  readonly images: readonly AttachedRef[];
  /** What the user actually typed (empty when they attached without typing). */
  readonly text: string;
}

/**
 * A folded block: the header line, then a fenced body. The fence is matched
 * non-greedily up to a closing fence that stands alone on its line, so a
 * pasted snippet containing ``` inside it does not truncate the block.
 */
const BLOCK = /^Attached file `([^`\n]*)`:\n```\n([\s\S]*?)\n```(?:\n\n|\n?$)/;

/** One path line. What follows the colon is read by {@link readLine}. */
const LINE = /^Attached (image|file|folder): ([^\n]+)(?:\n|$)/;

/** `/Users/…` here, `C:\…` on Windows. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** The last segment of a path. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/**
 * The path (and what it is) on one line. A file's line ends in `(…)`, a
 * folder's never does — which is how a folder called `drafts (old)` survives.
 */
function readLine(kind: string, rest: string): { path: string; detail?: string } | null {
  if (kind === 'folder') return isAbsolutePath(rest) ? { path: rest } : null;
  const m = /^(.*) \(([^()\n]*)\)$/.exec(rest);
  if (m === null) return null;
  const p = m[1] ?? '';
  return isAbsolutePath(p) ? { path: p, detail: m[2] ?? '' } : null;
}

/** Split a sent message body back into its attachments and the typed text. */
export function splitAttachedFiles(body: string): SplitMessage {
  const refs: AttachedRef[] = [];
  const images: AttachedRef[] = [];
  let rest = body;
  for (;;) {
    const m = LINE.exec(rest);
    if (m === null) break;
    const kind = m[1] as AttachedRef['kind'];
    const line = readLine(kind, m[2] ?? '');
    if (line === null) break;
    const into = kind === 'image' ? images : refs;
    into.push({
      id: `${kind}:${into.length}:${line.path}`,
      kind,
      path: line.path,
      name: baseName(line.path),
      ...(line.detail !== undefined ? { detail: line.detail } : {}),
    });
    rest = rest.slice(m[0].length);
  }
  // The blank line between the path lines and whatever follows them.
  if (refs.length + images.length > 0 && rest.startsWith('\n')) rest = rest.slice(1);

  const files: AttachedFile[] = [];
  for (;;) {
    const m = BLOCK.exec(rest);
    if (m === null) break;
    const named = m[1] ?? '';
    const path = isAbsolutePath(named) ? named : undefined;
    const name = path !== undefined ? baseName(path) : named;
    files.push({
      id: `${files.length}:${name}`,
      name,
      text: m[2] ?? '',
      ...(path !== undefined ? { path } : {}),
    });
    rest = rest.slice(m[0].length);
  }
  return { files, refs, images, text: rest };
}

/**
 * A picture saved from pixels (attachments-main.ts `image-<hash>.<ext>`): the
 * name is a content hash, which means nothing to a person.
 */
function isSavedPixels(name: string): boolean {
  return /^image-[0-9a-f]{12}\.[a-z0-9]+$/i.test(name);
}

/**
 * The one-line summary of a message for a list (the sidebar's chat title).
 *
 * A title made from the raw body is the folded block — which is how a chat ended
 * up called "Attached file `pasted content`: ```". The typed text is the honest
 * answer. With nothing typed, the files and folders it named name the chat,
 * then a NAMED text file, but "pasted content" names nothing, so a paste is
 * summarised by its own first line — which is what the conversation is actually
 * about. A picture alone is its file's name, or just "Image" when its name is
 * a hash.
 */
export function messageSummary(body: string): string {
  const { files, refs, images, text } = splitAttachedFiles(body);
  const typed = text.trim();
  if (typed.length > 0) return typed;
  if (refs.length > 0) {
    return [
      ...refs.map((r) => r.name),
      ...files.filter((f) => f.name !== PASTED_NAME).map((f) => f.name),
    ].join(', ');
  }
  const first = files[0];
  if (first !== undefined) {
    if (first.name !== PASTED_NAME) return files.map((f) => f.name).join(', ');
    return firstLine(first.text) || PASTED_NAME;
  }
  if (images.length > 0) {
    const named = images.filter((i) => !isSavedPixels(i.name)).map((i) => i.name);
    if (named.length > 0) return named.join(', ');
    return images.length === 1 ? 'Image' : `${images.length} images`;
  }
  return body.trim();
}

/** The first non-empty line of a block of text. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return '';
}
