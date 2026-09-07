/**
 * Build the message body pi actually receives from the typed text + attached
 * text files. The send path is otherwise images-only, so text-file contents are
 * folded in as fenced blocks; the visible bubble echoes only the typed text.
 *
 * Shared by the composer's `submit()` and predictive prefill so the prefilled
 * draft is BYTE-IDENTICAL to the sent message — that exact match is what lets the
 * real turn reuse the prefill's KV instead of re-prefilling.
 */
export interface TextFileAttachment {
  readonly name: string;
  readonly text?: string;
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

export function buildAgentMessage(
  raw: string,
  textFiles: readonly TextFileAttachment[],
  connectors: readonly ActivatableConnector[] = [],
): string {
  const fileBlocks = textFiles
    .map((a) => `Attached file \`${a.name}\`:\n\`\`\`\n${a.text ?? ''}\n\`\`\``)
    .join('\n\n');
  const activation = connectorActivationLine(activatedConnectors(raw, connectors));
  const body =
    fileBlocks.length === 0 ? raw : raw.length > 0 ? `${fileBlocks}\n\n${raw}` : fileBlocks;
  return activation === '' ? body : body.length > 0 ? `${body}\n\n${activation}` : activation;
}
