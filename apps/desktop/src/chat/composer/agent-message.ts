import { formatBytes } from './attachment-view';

/**
 * Build the message body pi actually receives from the typed text + attached
 * text files. The send path is otherwise images-only, so text-file contents are
 * folded in as fenced blocks; the visible bubble echoes only the typed text.
 *
 * Shared by the composer's `submit()` and predictive prefill so the prefilled
 * draft is BYTE-IDENTICAL to the sent message — that exact match is what lets the
 * real turn reuse the prefill's KV instead of re-prefilling.
 *
 * EVERYTHING WITH A FILE BEHIND IT IS NAMED BY ITS PATH (2026-09-24). the user: "why
 * not handle this natively so that any image(s)/files/folders... can be pasted
 * into the input box". A PDF, a zip or a folder cannot be folded into a prompt,
 * but the model has tools that can open them — all it lacked was where they are.
 * So each gets one line at the START of the message, ahead of the folds:
 *
 *   Attached image: /Users/…/fox.png (PNG, 1.2 MB)          also sent as pixels
 *   Attached file: /Users/…/Q3 report.pdf (PDF, 2.3 MB)
 *   Attached folder: /Users/…/garden-project
 *
 * and a text file's fold names its path where its bare name used to be
 * (`Attached file \`/Users/…/notes.md\`:`), so the model can edit the file it
 * was shown. A picture gets its line too, so "make it warmer" can reach
 * `edit_image` with a path. Every one of these is fixed the moment the thing is
 * attached, which is what keeps them inside the prefix predictive prefill primes
 * — nothing here may depend on what is typed after (attachment-prefill.ts).
 */
export type AttachmentKind = 'image' | 'text' | 'file' | 'folder';

export interface TextFileAttachment {
  /** `text` when absent — the only kind there was before paths. */
  readonly kind?: AttachmentKind;
  readonly name: string;
  readonly text?: string;
  /** Where it is on disk — absent for a paste, which never was a file. */
  readonly path?: string;
  /** A file's size, for its line. */
  readonly bytes?: number;
  /**
   * What its line says it is, verbatim — a message being edited keeps the
   * words it was sent with (`PDF, 2.3 MB`) rather than recomputing them.
   */
  readonly detail?: string;
}

/** An installed connector, as the composer knows it. */
export interface ActivatableConnector {
  /** What `/` inserts: the slug the user typed, without the slash. */
  readonly slug: string;
  /** The human name, for the sentence the model reads. */
  readonly name: string;
}

/**
 * Which connectors this draft turns on, in the order they appear.
 *
 * A `/gmail` in the text is a request, not a decoration: the user asked for the
 * pill to also "add this cli tool to the set if not already there". Reading it
 * back out of the text — rather than tracking it in state beside the text — is
 * what makes deleting the pill undo the activation, with no second thing to keep
 * in sync.
 *
 * `(?![\w-])` rather than a word boundary so `/gmail-drafts` does not match
 * `/gmail`, and a leading boundary so a path like `src/gmail` never does.
 */
export function activatedConnectors(
  raw: string,
  connectors: readonly ActivatableConnector[],
): ActivatableConnector[] {
  const seen = new Set<string>();
  const found: { at: number; connector: ActivatableConnector }[] = [];
  for (const c of connectors) {
    if (seen.has(c.slug)) continue;
    const at = new RegExp(`(?:^|[^\\w/-])/${escapeRegExp(c.slug)}(?![\\w-])`).exec(raw)?.index;
    if (at === undefined) continue;
    seen.add(c.slug);
    found.push({ at, connector: c });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.connector);
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The one line that tells the model a connector is live — appended to THIS
 * message, deliberately, and never added to the system prompt.
 *
 * the user: "not in the system prompt redoing prefill just right here append to the
 * message new cli tool activated by the user 'gmail', <others> this/these
 * tool(s) is/are now ready for use." The system prompt is the cached prefix; a
 * word added to it re-prefills the entire conversation, which is the exact cost
 * this app spends its effort avoiding. A line at the end of the user's own
 * message costs the tokens of the line.
 */
export function connectorActivationLine(connectors: readonly ActivatableConnector[]): string {
  if (connectors.length === 0) return '';
  const names = connectors.map((c) => `\`${c.slug}\` (${c.name})`).join(', ');
  const plural = connectors.length > 1;
  return (
    `[New CLI ${plural ? 'tools' : 'tool'} activated by the user: ${names}. ` +
    `${plural ? 'These tools are' : 'This tool is'} ready for use now — run ` +
    `${connectors.map((c) => `\`${c.slug} --help\``).join(' / ')} to see what ` +
    `${plural ? 'they' : 'it'} can do.]`
  );
}

/** A path that can stand on a line of its own (or in the fold's backticks). */
function lineSafe(p: string | undefined): p is string {
  return p !== undefined && p !== '' && !/[\r\n`]/.test(p);
}

/** `PDF`, `JPEG` — the extension as a person says it; '' for none. */
function extensionLabel(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toUpperCase() : '';
}

/**
 * The line that names an image, a file or a folder to the model — or null for
 * a text attachment (its fold is its line) and for anything without a path.
 *
 * A file's line always ends in `(what it is[, size])`, a folder's never does:
 * that is what lets attached-files.ts read the path back exactly, spaces and
 * brackets in folder names included.
 */
export function attachmentLine(a: TextFileAttachment): string | null {
  const kind = a.kind ?? 'text';
  if (kind === 'text' || !lineSafe(a.path)) return null;
  if (kind === 'folder') return `Attached folder: ${a.path}`;
  if (a.detail !== undefined && a.detail !== '' && !/[()\r\n]/.test(a.detail)) {
    return `Attached ${kind}: ${a.path} (${a.detail})`;
  }
  const what = extensionLabel(a.path) || (kind === 'image' ? 'image' : 'file');
  const size = a.bytes !== undefined ? formatBytes(a.bytes) : '';
  return `Attached ${kind}: ${a.path} (${size === '' ? what : `${what}, ${size}`})`;
}

export function buildAgentMessage(
  raw: string,
  attachments: readonly TextFileAttachment[],
  connectors: readonly ActivatableConnector[] = [],
): string {
  const lines = attachments
    .map(attachmentLine)
    .filter((l): l is string => l !== null)
    .join('\n');
  const fileBlocks = attachments
    .filter((a) => (a.kind ?? 'text') === 'text')
    .map(
      (a) =>
        `Attached file \`${lineSafe(a.path) ? a.path : a.name}\`:\n\`\`\`\n${a.text ?? ''}\n\`\`\``,
    )
    .join('\n\n');
  const head = [lines, fileBlocks].filter((part) => part.length > 0).join('\n\n');
  const activation = connectorActivationLine(activatedConnectors(raw, connectors));
  const body = head.length === 0 ? raw : raw.length > 0 ? `${head}\n\n${raw}` : head;
  return activation === '' ? body : body.length > 0 ? `${body}\n\n${activation}` : activation;
}
