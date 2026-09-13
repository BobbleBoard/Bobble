/**
 * Canvas-awareness — inject "what is on the canvas" into the model's context
 * (the user's gotcha: the model must always know what the user is looking at).
 *
 * pi's `context` hook (`ContextEvent { messages }` → `{ messages? }`) fires
 * before each LLM call and returns a NON-destructive replacement message list —
 * the persisted session is untouched (same seam the web-tools image sanitizer
 * uses). The compact {@link CanvasState} MAIN caches (over the existing
 * browser-agent socket) is rendered as a small `<canvas_state>` block and
 * merged into the user's turn.
 *
 * ONE BLOCK PER USER TURN, AND IT STAYS. The block is read once, at the first
 * LLM call after a user message, and that exact text is attached to that
 * message on every later call — this turn's tool steps and every turn after.
 * It used to be stripped and re-read before every call ("refreshed every
 * turn"), which MEASURED (2026-09-13, prompt-diff over consecutive requests on
 * llama.cpp and rapid-mlx) as the conversation tail re-prefilling on every
 * turn: the previous user message lost its block, so the prefix cache matched
 * only up to that message's own text and the whole previous turn — reply, tool
 * calls, results — was computed again. Kept where it was, the history is
 * byte-identical turn to turn and only the new turn is new. It also stops the
 * model chasing its own reflection mid-turn (the surfaces it opens itself
 * appearing as "the user is looking at" between two tool calls).
 *
 * The blocks live in a {@link CanvasBlockLedger} (keyed by the user message's
 * timestamp), persisted as custom session entries so a reload renders the same
 * bytes.
 *
 * `Message` has no `system` role (system is a separate `systemPrompt`), so the
 * block rides in the user's own turn. Structural (no pi imports beyond the
 * event type) so it unit-tests in plain Node.
 */
import type { ContextEvent, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { CanvasState, CanvasSurfaceState } from './protocol.js';

/** The message shape pi's `context` hook operates on. Derived from the exported
 * {@link ContextEvent} so we don't take a direct dep on `@mariozechner/pi-agent-core`. */
export type CanvasContextMessage = ContextEvent['messages'][number];

/** The narrow surface the context hook depends on (a `BrowserAgentClient`, or a
 * fake in tests). Separate from `BrowserBridge` so adding it never disturbs the
 * tool bridges. */
export interface CanvasStateSource {
  getCanvasState(): Promise<CanvasState | null>;
}

/** Sentinel wrapping the injected block, so a prior copy is found + stripped. */
export const CANVAS_STATE_OPEN = '<canvas_state>';
export const CANVAS_STATE_CLOSE = '</canvas_state>';

/** Excerpts injected for an open file are capped so the block stays cache-cheap. */
const EXCERPT_MAX_CHARS = 240;

/** A one-liner describing a single surface (e.g. `Browser — "Sandboxels"
 * (https://neal.fun/sandboxels/)`). Terser when a field is absent. */
function describeSurface(s: CanvasSurfaceState): string {
  const title = s.title?.trim();
  switch (s.kind) {
    case 'browser': {
      const url = s.url?.trim();
      const named = title && title.length > 0 && title !== 'New tab' ? `"${title}"` : null;
      if (named && url) return `Browser — ${named} (${url})`;
      if (url) return `Browser (${url})`;
      if (named) return `Browser — ${named}`;
      return 'Browser (blank tab)';
    }
    case 'file':
    case 'code': {
      const label = s.filePath?.trim() || title || 'a file';
      /*
       * THE SAME REFLECTION, ONE SURFACE OVER. The Activity tab morphs into
       * whatever the agent last wrote; reported as "The user is looking at:
       * File illustration1.md" it became, to a 4B, the user reading its
       * description files — "I see you're viewing the illustration
       * descriptions I created" — five times in a row, each time writing
       * another file the tab then showed (SEEN, the children's book in CLI
       * mode; the renderer froze under the churn). It is the agent's output.
       */
      if (s.own === true) {
        return `File ${label} — YOUR OWN write as it landed, not something the user opened or asked about`;
      }
      return `File ${label}${s.dirty === true ? ' (unsaved)' : ''}`;
    }
    case 'terminal': {
      /*
       * SAY WHOSE TERMINAL THIS IS.
       *
       * MEASURED on a matrix run: a 4B's own failing bash commands opened the
       * activity terminal, the block then reported "The user is looking at:
       * Terminal", and the model spent four turns trying to read Terminal — "the
       * user is looking at Terminal. I need to use the read tool ... to read the
       * Chrome tab." It was chasing its own reflection. The surface is the
       * agent's OUTPUT, not a thing the user chose to open.
       */
      const parts: string[] = [];
      if (s.cwd) parts.push(`cwd ${s.cwd}`);
      if (s.lastCommand) parts.push(`last: \`${s.lastCommand}\``);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `Terminal — YOUR OWN command output, not something to act on${detail}`;
    }
    case 'image':
      return `Image${title ? ` "${title}"` : ''}`;
    case 'pdf':
      return `PDF${title ? ` "${title}"` : ''}`;
    case 'filetree':
      return 'File tree';
    case 'subagent':
      return 'Subagents panel';
    case 'html':
    case 'svg':
    case 'markdown':
      return `${s.kind.toUpperCase()} preview${title ? ` "${title}"` : ''}`;
    default:
      return `${s.kind}${title ? ` "${title}"` : ''}`;
  }
}

/**
 * Render the canvas snapshot as the compact `<canvas_state>` block. Returns
 * `null` when there is genuinely nothing on the canvas (so the hook can skip
 * injecting an empty block).
 */
export function formatCanvasSummary(state: CanvasState): string | null {
  const active = state.active;
  const others = state.others ?? [];
  if (active === null && others.length === 0) return null;

  const lines: string[] = [];
  /*
   * SAY WHAT THIS IS, because of where it has to live.
   *
   * `Message` has no system role, so the block rides in a USER message — and a
   * user message that opens "The user is looking at…" reads, to a model, as the
   * user having just said something. MEASURED in demo runs: "The user sent a
   * canvas_state update. I should continue…" and, worse, "The user resent the
   * same message." Both are the model spending a turn on a status line and one
   * of them is it believing it was interrupted.
   */
  lines.push(
    'Automatic status of the app, refreshed every turn. NOT a message from the ' +
      'user and never a new request — if it is all that changed, nothing was asked of you.',
  );
  lines.push(
    active !== null
      ? active.own === true
        ? `On screen: ${describeSurface(active)}`
        : `The user is looking at: ${describeSurface(active)}`
      : 'The canvas is open (no surface focused).',
  );
  if (others.length > 0) {
    lines.push(`Also open: ${others.map(describeSurface).join(' · ')}`);
  }
  // No excerpt of the agent's own write: it knows what it wrote, and quoting
  // it back is what made it read as the user having opened the file.
  const excerpt = active?.own === true ? undefined : active?.excerpt?.trim();
  if (excerpt) {
    const clipped =
      excerpt.length > EXCERPT_MAX_CHARS ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…` : excerpt;
    lines.push(`Excerpt:\n${clipped}`);
  }
  return `${CANVAS_STATE_OPEN}\n${lines.join('\n')}\n${CANVAS_STATE_CLOSE}`;
}

/** The plain text of a message (string content or joined text blocks). */
function messageText(msg: CanvasContextMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** Matches an injected block (with any leading blank line from a merge). */
const CANVAS_BLOCK_RE = /\n{0,2}<canvas_state>[\s\S]*?<\/canvas_state>[ \t]*/g;

/** A message's content (string OR text-block array) with any injected block
 * span removed; empty text blocks are dropped. */
function contentWithoutBlock(content: unknown): unknown {
  if (typeof content === 'string') return content.replace(CANVAS_BLOCK_RE, '');
  if (!Array.isArray(content)) return content;
  return content
    .map((b) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? {
            ...(b as object),
            text: String((b as { text?: unknown }).text ?? '').replace(CANVAS_BLOCK_RE, ''),
          }
        : b,
    )
    .filter(
      (b) =>
        !(
          b !== null &&
          typeof b === 'object' &&
          (b as { type?: unknown }).type === 'text' &&
          String((b as { text?: unknown }).text ?? '').length === 0
        ),
    );
}

/** True for a USER message still carrying an injected `<canvas_state>` block.
 * Role-guarded so an assistant turn that merely mentions the tag is left alone
 * (we only ever inject into the user's own turn). */
export function isCanvasStateMessage(msg: CanvasContextMessage): boolean {
  if ((msg as { role?: unknown }).role !== 'user') return false;
  return messageText(msg).includes(CANVAS_STATE_OPEN);
}

/** Append the block into a message's content (string or text-block array). */
function appendBlock(msg: CanvasContextMessage, block: string): CanvasContextMessage {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') {
    return { ...(msg as object), content: `${content}\n\n${block}` } as CanvasContextMessage;
  }
  if (Array.isArray(content)) {
    return {
      ...(msg as object),
      content: [...content, { type: 'text', text: `\n\n${block}` }],
    } as CanvasContextMessage;
  }
  return { ...(msg as object), content: block } as CanvasContextMessage;
}

/**
 * Return `messages` with any prior injected block STRIPPED, then the fresh
 * `block` MERGED INTO the current (last) user turn — NOT added as a separate
 * message. The provider sends messages verbatim to llama-server's
 * `/chat/completions`, where Gemma's `--jinja` template requires strict
 * user/model alternation; a second trailing `user` message would break it. If
 * the last message somehow isn't a user turn, we fall back to a new user
 * message. Either way the volatile block sits at the very tail, so the stable
 * prefix (system + history + the user's prompt) is preserved for the KV cache.
 */
export function withCanvasBlock(
  messages: readonly CanvasContextMessage[],
  block: string,
): CanvasContextMessage[] {
  const kept = stripCanvasBlock(messages);
  const last = kept[kept.length - 1];
  if (last !== undefined && (last as { role?: unknown }).role === 'user') {
    return [...kept.slice(0, -1), appendBlock(last, block)];
  }
  return [...kept, { role: 'user', content: block, timestamp: Date.now() } as CanvasContextMessage];
}

/** Strip any injected block without appending a new one (canvas went empty).
 * Removes the block SPAN from message content and drops a message that becomes
 * empty (an older separate-message injection). */
export function stripCanvasBlock(
  messages: readonly CanvasContextMessage[],
): CanvasContextMessage[] {
  const out: CanvasContextMessage[] = [];
  for (const msg of messages) {
    if (!isCanvasStateMessage(msg)) {
      out.push(msg);
      continue;
    }
    const content = contentWithoutBlock((msg as { content?: unknown }).content);
    const emptied =
      (typeof content === 'string' && content.trim().length === 0) ||
      (Array.isArray(content) && content.length === 0);
    if (!emptied) out.push({ ...(msg as object), content } as CanvasContextMessage);
  }
  return out;
}

/** The custom session entry a turn's block is persisted under. */
export const CANVAS_BLOCK_ENTRY = 'bobble-canvas-block';

/** A persisted block: which user turn (its timestamp) said what. */
export interface CanvasBlockRecord {
  readonly at: number;
  /** '' = that turn had nothing on the canvas (and gets no block, ever). */
  readonly block: string;
}

/** The shape of a session entry this module reads back (structural). */
interface EntryLike {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * What each user turn was told about the canvas, so that turn renders the same
 * bytes on every later request. Kept per session; restored from the session's
 * custom entries on `session_start`; new records are handed to `persist` as they
 * are made.
 */
export class CanvasBlockLedger {
  private readonly byTurn = new Map<number, string>();
  private readonly pending: CanvasBlockRecord[] = [];

  /** Forget everything (a session switch) and take the records `entries` carry. */
  restore(entries: readonly EntryLike[]): void {
    this.byTurn.clear();
    this.pending.length = 0;
    for (const e of entries) {
      if (e.type !== 'custom' || e.customType !== CANVAS_BLOCK_ENTRY) continue;
      const d = e.data as Partial<CanvasBlockRecord> | undefined;
      if (typeof d?.at === 'number' && typeof d.block === 'string') this.byTurn.set(d.at, d.block);
    }
  }

  has(at: number): boolean {
    return this.byTurn.has(at);
  }

  get(at: number): string | undefined {
    return this.byTurn.get(at);
  }

  set(at: number, block: string): void {
    this.byTurn.set(at, block);
    this.pending.push({ at, block });
  }

  /** Records made since the last drain — what to persist. */
  drain(): CanvasBlockRecord[] {
    return this.pending.splice(0);
  }
}

/** A message's timestamp, the key a turn's block is kept under. */
function turnKey(msg: CanvasContextMessage): number | undefined {
  const t = (msg as { timestamp?: unknown }).timestamp;
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
}

/**
 * Compute the context-hook result for one LLM call: every user turn carries
 * the block it was given (from the ledger), and the LAST user turn gets one
 * now if it has none yet — read from the canvas once, then remembered.
 * Returns `undefined` for "no change" (so pi keeps the original array).
 * Pure apart from the ledger + source; injectable for tests.
 */
export async function buildCanvasContext(
  source: CanvasStateSource,
  messages: readonly CanvasContextMessage[],
  ledger: CanvasBlockLedger = new CanvasBlockLedger(),
): Promise<{ messages: CanvasContextMessage[] } | undefined> {
  // Defensive: a block that somehow persisted (an old session) is replaced by
  // the ledger's copy or dropped, never doubled.
  const kept = stripCanvasBlock(messages);
  let lastUser = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if ((kept[i] as { role?: unknown }).role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return undefined;

  const last = kept[lastUser] as CanvasContextMessage;
  const key = turnKey(last);
  if (key !== undefined && !ledger.has(key)) {
    let state: CanvasState | null;
    try {
      state = await source.getCanvasState();
    } catch {
      state = null;
    }
    ledger.set(key, (state !== null ? formatCanvasSummary(state) : null) ?? '');
  }

  let changed = false;
  const out = kept.map((msg) => {
    if ((msg as { role?: unknown }).role !== 'user') return msg;
    const k = turnKey(msg);
    const block = k === undefined ? undefined : ledger.get(k);
    if (block === undefined || block === '') return msg;
    changed = true;
    return appendBlock(msg, block);
  });
  // A turn without a timestamp (a programmatic caller) still gets a fresh read.
  if (key === undefined) {
    let state: CanvasState | null;
    try {
      state = await source.getCanvasState();
    } catch {
      state = null;
    }
    const block = state !== null ? formatCanvasSummary(state) : null;
    if (block !== null) {
      out[lastUser] = appendBlock(out[lastUser] as CanvasContextMessage, block);
      changed = true;
    }
  }
  return changed ? { messages: out } : undefined;
}

/**
 * Register the canvas-awareness `context` hook. Safe to call only when a bridge
 * exists (inside Pi Desktop); outside it there is nothing to report. The ledger
 * is restored from the session on `session_start` and its new records are
 * appended as custom entries when the turn ends.
 */
export function registerCanvasContext(pi: ExtensionAPI, source: CanvasStateSource): void {
  const ledger = new CanvasBlockLedger();
  pi.on('session_start', (_event, ctx) => {
    const sm = ctx.sessionManager as { getEntries?: () => readonly EntryLike[] } | undefined;
    ledger.restore(sm?.getEntries?.() ?? []);
  });
  pi.on('context', (event) => buildCanvasContext(source, event.messages, ledger));
  pi.on('agent_end', () => {
    for (const record of ledger.drain()) pi.appendEntry(CANVAS_BLOCK_ENTRY, record);
  });
}
