/**
 * A DIAGRAM CALL, WHILE IT IS BEING TYPED — what the live card reads out of it.
 *
 * the user (2026-09-25): diagrams should "animate/build in real time smoothly". A
 * `diagram` call is the model typing Mermaid a few characters at a time —
 * through the tool's own arguments (`{"title": …, "source": "flowchart TD\n
 * A --> B…"}`) or as a command line through bash (`diagram "Title" --source
 * 'flowchart TD …'`). The card draws what has arrived; this module decides
 * what that is, and when to ask for the next frame. Pure: no React, no DOM.
 *
 *   pendingDiagramArgs  the title, the source so far (and whether it has
 *                       closed), the kit and look, from either form
 *   liveSource          the part Mermaid can read: WHOLE lines only — a half-
 *                       typed line is a parse error every time — with any
 *                       block still open (a subgraph, an alt, a class body)
 *                       closed, so a diagram builds inside its groups instead
 *                       of stalling until the group's `end` arrives
 *   nextRender          at most one frame every ~200 ms, one in flight, and
 *                       only when the lines have changed
 */
import { partialJsonString } from './partial-json';

/** What a diagram call has said so far. */
export interface PendingDiagramArgs {
  readonly title?: string;
  readonly subtitle?: string;
  /** The Mermaid so far. */
  readonly source?: string;
  /** Whether the source has closed (its JSON string or its shell quote ended). */
  readonly sourceClosed: boolean;
  readonly kit?: string;
  readonly look?: 'clean' | 'sketch';
}

/** The first word of a Mermaid source, for each kind the tool draws. */
const TYPE_LINE =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|gitGraph|sankey(?:-beta)?|requirementDiagram|C4\w+|block(?:-beta)?|architecture-beta|xychart-beta|packet-beta|kanban|radar-beta|treemap-beta)\b/;

/** The flags the `diagram` command reads its source from (tool-cli.ts FLAG_ALIASES). */
const SOURCE_FLAGS = new Set(['source', 'mermaid', 'mmd', 'definition', 'diagram']);

/** One word of a command line, and whether it has ended. */
interface ShellWord {
  readonly value: string;
  readonly closed: boolean;
}

/**
 * The words of a command line that may still be arriving: '…', "…" (with
 * bash's escapes), $'…' (with its \n), bare words. A quote not yet closed is
 * the last word, not closed; so is a bare word the buffer ends in, unless the
 * line is `complete`. A `;`, `&` or `|` outside quotes ends the command.
 */
export function shellWords(line: string, complete = false): ShellWord[] {
  const out: ShellWord[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i] ?? '')) i += 1;
    if (i >= n) break;
    let value = '';
    let closed = true;
    let ended = false;
    // Whether the word's last part was a closed quote (it cannot grow).
    let quoted = false;
    while (i < n && !/\s/.test(line[i] ?? '')) {
      const c = line[i] ?? '';
      if (c === ';' || c === '&' || c === '|') {
        ended = true;
        break;
      }
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end === -1) {
          value += line.slice(i + 1);
          i = n;
          closed = false;
          break;
        }
        value += line.slice(i + 1, end);
        i = end + 1;
        quoted = true;
        continue;
      }
      if (c === '$' && line[i + 1] === "'") {
        i += 2;
        let done = false;
        while (i < n) {
          const d = line[i] ?? '';
          if (d === '\\' && i + 1 < n) {
            const e = line[i + 1] ?? '';
            value += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            i += 2;
            continue;
          }
          if (d === "'") {
            done = true;
            i += 1;
            break;
          }
          value += d;
          i += 1;
        }
        if (!done) {
          closed = false;
          break;
        }
        quoted = true;
        continue;
      }
      if (c === '"') {
        i += 1;
        let done = false;
        while (i < n) {
          const d = line[i] ?? '';
          if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(line[i + 1] ?? '')) {
            value += line[i + 1];
            i += 2;
            continue;
          }
          if (d === '"') {
            done = true;
            i += 1;
            break;
          }
          value += d;
          i += 1;
        }
        if (!done) {
          closed = false;
          break;
        }
        quoted = true;
        continue;
      }
      if (c === '\\' && i + 1 < n) {
        value += line[i + 1];
        quoted = false;
        i += 2;
        continue;
      }
      value += c;
      quoted = false;
      i += 1;
    }
    // A bare word the buffer ends in may still be growing.
    if (closed && !quoted && !complete && i >= n && !/\s$/.test(line)) closed = false;
    if (value !== '' || quoted || !closed) out.push({ value, closed });
    if (!closed || ended) break;
  }
  return out;
}

/** A source handed over as `$(cat <<'EOF' … EOF)`: the text between the markers. */
function heredoc(value: string, closed: boolean): { text: string; closed: boolean } {
  const m = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*)$/.exec(value);
  if (m === null) return { text: value, closed };
  const marker = m[2] ?? 'EOF';
  const body = m[3] ?? '';
  const at = body.search(new RegExp(`(^|\\n)[ \\t]*${marker}[ \\t]*(\\n|\\)|$)`));
  return at === -1 ? { text: body, closed: false } : { text: body.slice(0, at), closed: true };
}

/** Whether text handed over as a title is really the diagram (diagram-tool.ts looksLikeMermaid). */
function looksLikeMermaid(text: string): boolean {
  return (
    /\n|\\n/.test(text.trim()) && (TYPE_LINE.test(text.trim()) || /-->|->>|-\.->|==>/.test(text))
  );
}

/**
 * The diagram call's arguments so far, from a `diagram` tool call or a
 * `diagram …` command through bash; null for anything else (`diagram edit`
 * changes a drawing that exists — its card is the finished one's).
 */
export function pendingDiagramArgs(block: {
  name: string;
  arguments?: Record<string, unknown>;
  argsText?: string;
}): PendingDiagramArgs | null {
  const args = block.arguments ?? {};
  const raw = block.argsText ?? '';
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const look = (v: unknown): 'clean' | 'sketch' | undefined =>
    v === 'clean' || v === 'sketch' ? v : undefined;
  if (block.name === 'diagram') {
    // A value the engine has parsed is whole; one still in the raw text is
    // only as whole as its closing quote says.
    const pick = (key: string): { value: string; closed: boolean } | undefined => {
      const done = str(args[key]);
      if (done !== undefined) return { value: done, closed: true };
      const partial = partialJsonString(raw, [key]);
      return partial !== undefined && partial.value !== ''
        ? { value: partial.value, closed: partial.complete }
        : undefined;
    };
    let source = pick('source');
    let title = pick('title');
    if (source === undefined && title !== undefined && looksLikeMermaid(title.value)) {
      source = title;
      title = undefined;
    }
    const subtitle = pick('subtitle');
    const kit = pick('kit');
    const lk = look(pick('look')?.value);
    if (source === undefined && title === undefined) return null;
    return {
      sourceClosed: source?.closed ?? false,
      ...(source !== undefined ? { source: source.value } : {}),
      // A title is drawn once it is whole — a frame per character is noise.
      ...(title?.closed === true ? { title: title.value } : {}),
      ...(subtitle?.closed === true ? { subtitle: subtitle.value } : {}),
      ...(kit?.closed === true ? { kit: kit.value } : {}),
      ...(lk !== undefined ? { look: lk } : {}),
    };
  }
  if (block.name !== 'bash') return null;
  const parsed = str(args.command);
  const partial = parsed === undefined ? partialJsonString(raw, ['command']) : undefined;
  const command = parsed ?? partial?.value ?? '';
  if (!/^\s*diagram\s/.test(command)) return null;
  const words = shellWords(command, parsed !== undefined || partial?.complete === true);
  if (words[0]?.value !== 'diagram' || words[1]?.value === 'edit') return null;
  const flags = new Map<string, ShellWord>();
  const positionals: ShellWord[] = [];
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i] as ShellWord;
    const flag = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(w.value);
    if (flag === null) {
      positionals.push(w);
      continue;
    }
    const name = (flag[1] ?? '').toLowerCase();
    if (flag[2] !== undefined) {
      flags.set(name, { value: flag[2], closed: w.closed });
      continue;
    }
    // A flag with no value yet (`--sour` at the buffer's end) waits for one.
    const next = words[i + 1];
    if (next !== undefined && !next.value.startsWith('-')) {
      flags.set(name, next);
      i += 1;
    }
  }
  let source: ShellWord | undefined;
  for (const [name, w] of flags) if (SOURCE_FLAGS.has(name)) source = w;
  let title = flags.get('title');
  const rest = [...positionals];
  if (title === undefined && rest[0] !== undefined && !looksLikeMermaid(rest[0].value)) {
    title = rest.shift();
  }
  if (source === undefined && rest[0] !== undefined) source = rest[0];
  if (source === undefined && title === undefined) return null;
  const body = source !== undefined ? heredoc(source.value, source.closed) : undefined;
  const subtitle = flags.get('subtitle');
  const kit = flags.get('kit');
  const lk = look(flags.get('look')?.value);
  return {
    sourceClosed: body?.closed ?? false,
    ...(body !== undefined && body.text !== '' ? { source: body.text } : {}),
    ...(title?.closed === true && title.value !== '' ? { title: title.value } : {}),
    ...(subtitle?.closed === true ? { subtitle: subtitle.value } : {}),
    ...(kit?.closed === true ? { kit: kit.value } : {}),
    ...(lk !== undefined ? { look: lk } : {}),
  };
}

// ── the part Mermaid can read ────────────────────────────────────────────────

/** The line that opens a block in this kind of diagram → the line that closes it. */
function opens(kind: string, line: string): string | null {
  if (kind === 'flowchart') return /^subgraph\b/.test(line) ? 'end' : null;
  if (kind === 'sequence') {
    return /^(?:loop|alt|opt|par|par_over|critical|break|rect|box)\b/.test(line) ? 'end' : null;
  }
  // A state's, a class's, a namespace's or an entity's body.
  if (kind === 'braces') return /\{$/.test(line) ? '}' : null;
  return null;
}

/**
 * The lines with every block still open at the end closed, innermost first.
 * A group opened with nothing in it yet is left out rather than closed: an
 * empty `subgraph Warehouse … end` is drawn by Mermaid as a STEP called
 * "Warehouse" — a box that stood for a frame and then faded out when the
 * group's first line turned it into a frame (diagram-build-look.mjs). A
 * class's or an entity's empty body is its name alone, so that is closed.
 */
function closeOpen(kind: string, lines: readonly string[]): string[] {
  const stack: Array<{ at: number; closer: string; filled: boolean }> = [];
  lines.forEach((raw, at) => {
    const line = raw.replace(/%%.*$/, '').trim();
    if (line === '') return;
    if (line === (stack[stack.length - 1]?.closer ?? null)) {
      stack.pop();
      return;
    }
    const closer = opens(kind, line);
    if (closer !== null) {
      stack.push({ at, closer, filled: false });
      return;
    }
    for (const block of stack) block.filled = true;
  });
  const drop = new Set<number>();
  const tail: string[] = [];
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const block = stack[k];
    if (block === undefined) continue;
    if (!block.filled && kind !== 'braces') drop.add(block.at);
    else tail.push(block.closer);
  }
  return [...lines.filter((_, i) => !drop.has(i)), ...tail];
}

/**
 * The source as far as Mermaid can read it, or null when there is nothing to
 * draw yet (no whole type line, or not Mermaid at all — a path to a file).
 *
 *   - `\n` typed as two characters on one line is read as line breaks, and a
 *     ``` fence is taken off (prepareSource does both for the finished one);
 *   - only whole lines, unless the source has closed;
 *   - any block still open is closed at the end.
 */
export function liveSource(raw: string | undefined, closed: boolean): string | null {
  if (raw === undefined) return null;
  let text = raw.replace(/\r\n?/g, '\n');
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  text = text.replace(/^\s*```[ \t]*(?:mermaid|mmd)?[ \t]*\n/i, '');
  text = text.replace(/\n[ \t]*```[\s\S]*$/, '');
  if (!closed) {
    const cut = text.lastIndexOf('\n');
    text = cut === -1 ? '' : text.slice(0, cut);
  }
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && (lines[lines.length - 1] ?? '') === '') lines.pop();
  const first = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('%%'));
  if (first === undefined || !TYPE_LINE.test(first.trim())) return null;
  const type = /^\s*(\S+)/.exec(first)?.[1] ?? '';
  const kind = /^(?:flowchart|graph)$/.test(type)
    ? 'flowchart'
    : type === 'sequenceDiagram'
      ? 'sequence'
      : /^(?:stateDiagram|stateDiagram-v2|classDiagram|erDiagram)$/.test(type)
        ? 'braces'
        : 'other';
  return closeOpen(kind, lines).join('\n');
}

// ── when to ask for the next frame ───────────────────────────────────────────

/** A live card's frame requests so far. */
export interface RenderState {
  /** What the last frame asked for drew (its key), or null before the first. */
  readonly lastKey: string | null;
  /** When it was asked for (ms). */
  readonly lastAt: number;
  /** One is being drawn right now. */
  readonly inFlight: boolean;
}

export type RenderDecision =
  | { readonly kind: 'now' }
  | { readonly kind: 'later'; readonly waitMs: number }
  | { readonly kind: 'skip' };

/** The least time between two frames. */
export const FRAME_GAP_MS = 200;

/**
 * Whether to ask for a frame for `key` now, later or not at all: never twice
 * for the same lines, never while one is being drawn (the reply re-asks),
 * never closer than `gapMs` to the last — but the first one at once.
 */
export function nextRender(
  state: RenderState,
  key: string | null,
  now: number,
  gapMs = FRAME_GAP_MS,
): RenderDecision {
  if (key === null || key === state.lastKey) return { kind: 'skip' };
  if (state.inFlight) return { kind: 'later', waitMs: gapMs };
  if (state.lastKey === null) return { kind: 'now' };
  const since = now - state.lastAt;
  return since >= gapMs ? { kind: 'now' } : { kind: 'later', waitMs: gapMs - since };
}
