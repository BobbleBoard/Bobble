/**
 * The outgoing request, on record — for the one question that keeps coming
 * back: "why did the prefix cache only reuse N tokens?"
 *
 * `PI_DIAG_PROMPTS=<file>` appends one SHAPE line per request (every message's
 * role + length, the tool names, the system prompt's length), which is enough
 * to see a message appear or grow. It is not enough to see one CHANGE — a
 * timestamp of the same length, a reordered tool, a re-rendered earlier turn —
 * so `PI_DIAG_PROMPTS_FULL=1` also appends the whole body as one JSON line to
 * `<file>.bodies.jsonl`, and `tests/e2e/prompt-diff.mjs` says where two
 * consecutive bodies first part company. Both providers call this after their
 * `onPayload` hook, so what is recorded is what went over the wire.
 *
 * `PI_DIAG_PROMPTS=1` prints the shape line to stderr instead (pi's own stderr
 * is not kept by the app, so the file form is the useful one). Never throws.
 */
import { appendFileSync } from 'node:fs';

export function tapRequest(body: Record<string, unknown>, engine: string): void {
  const diag = process.env.PI_DIAG_PROMPTS;
  if (diag === undefined || diag === '') return;
  try {
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<{ role?: string; content?: unknown }>)
      : [];
    const shape = messages.map((m) => {
      const c = m.content;
      const len = typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
      return `${m.role ?? '?'}:${len}`;
    });
    const tools = Array.isArray(body.tools)
      ? (body.tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name ?? '?')
      : [];
    const system = messages.find((m) => m.role === 'system');
    const sys = typeof system?.content === 'string' ? system.content.length : 0;
    const line = `[pi-diag-prompt] engine=${engine} msgs=[${shape.join(' ')}] tools=[${tools.join(',')}] sys=${sys}\n`;
    if (diag.includes('/')) {
      appendFileSync(diag, line);
      if (process.env.PI_DIAG_PROMPTS_FULL === '1') {
        appendFileSync(
          `${diag}.bodies.jsonl`,
          `${JSON.stringify({ engine, at: Date.now(), body })}\n`,
        );
      }
    } else process.stderr.write(line);
  } catch {
    /* a diagnostic never breaks a turn */
  }
}
