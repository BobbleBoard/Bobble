/**
 * A chat, as a file someone can keep.
 *
 * Everything in this app is already a real file — the session JSONL is right
 * there on disk — and there was still no way to get a conversation out of it.
 * Not to a note, not to a colleague, not into a commit message.
 *
 * TWO FORMATS, BECAUSE THEY ARE FOR DIFFERENT THINGS. Markdown is for a person:
 * roles as headings, tool calls named rather than dumped, no ids. The raw JSONL
 * is the session verbatim, for anything that wants to read it back — including
 * this app.
 *
 * Pure and fs-free so it can be tested against a transcript rather than a
 * machine. `renderSessionMarkdown` takes the JSONL text and gives back the
 * document.
 */

/** One rendered turn. Exported for the tests, which assert on structure. */
export interface ExportedTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Tools this turn called, in order, named only — never their arguments. */
  readonly tools: readonly string[];
}

interface SessionHead {
  readonly startedAt?: string;
  readonly cwd?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('\n');
}

function toolsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; name?: string; toolName?: string };
    if (p?.type === 'toolCall' || p?.type === 'tool_use' || p?.type === 'toolUse') {
      const name = p.name ?? p.toolName;
      if (typeof name === 'string' && name !== '') names.push(name);
    }
  }
  return names;
}

/** Parse a session JSONL into the turns worth showing a person. */
export function parseSessionTurns(jsonl: string): { head: SessionHead; turns: ExportedTurn[] } {
  const turns: ExportedTurn[] = [];
  let head: SessionHead = {};
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A truncated final line is normal for a session being appended to.
      continue;
    }
    if (obj.type === 'session') {
      head = {
        ...(typeof obj.timestamp === 'string' ? { startedAt: obj.timestamp } : {}),
        ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
      };
      continue;
    }
    const msg = (obj.type === 'message' && obj.message !== undefined ? obj.message : obj) as Record<
      string,
      unknown
    >;
    const role = (msg.role ?? obj.role) as string | undefined;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.content ?? obj.content;
    const text = textOf(content).trim();
    const tools = toolsOf(content);
    // A turn that is only a tool call still belongs in the transcript — dropping
    // it makes the assistant look as if it answered out of nowhere.
    if (text === '' && tools.length === 0) continue;
    turns.push({ role, text, tools });
  }
  return { head, turns };
}

/**
 * Render a session as Markdown.
 *
 * `title` is passed in rather than derived: the app knows about renames and this
 * file does not, and exporting a chat under a name the user changed six weeks
 * ago is exactly the kind of small wrongness that makes an export untrustworthy.
 */
export function renderSessionMarkdown(jsonl: string, title: string): string {
  const { head, turns } = parseSessionTurns(jsonl);
  const out: string[] = [`# ${title.trim() === '' ? 'Untitled chat' : title.trim()}`, ''];
  const meta: string[] = [];
  if (head.startedAt !== undefined) meta.push(`Started ${head.startedAt}`);
  if (head.cwd !== undefined) meta.push(`Folder \`${head.cwd}\``);
  if (meta.length > 0) out.push(`_${meta.join(' · ')}_`, '');

  for (const turn of turns) {
    out.push(turn.role === 'user' ? '## You' : '## Assistant', '');
    if (turn.text !== '') out.push(turn.text, '');
    if (turn.tools.length > 0) {
      // Named, not dumped: arguments are frequently whole files, and a
      // transcript nobody can read is not an export.
      out.push(`_Ran: ${turn.tools.map((t) => `\`${t}\``).join(', ')}_`, '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
