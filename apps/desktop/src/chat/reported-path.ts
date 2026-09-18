/**
 * The path a write/edit tool RESULT names — the one place the disk's truth is
 * stated. A call's own `path` is whatever the model typed, relative to a root
 * only the tools know for sure; the row in the thread and the tab in the
 * canvas both key on this once it is in. No imports, so both sides of the
 * activity code can use it without a cycle.
 *
 * RELATIVE SINCE 2026-09-17. The harness now says the path the way the model
 * should repeat it — relative to the chat's working folder ("Successfully
 * wrote 88 bytes to sample.svg") — and keeps the absolute form only for a file
 * outside that folder. Callers resolve a relative answer against the working
 * folder the harness publishes (`workspaceRoot`), the same root the tools used,
 * so the two sides still agree on the file.
 */
/** "Successfully wrote N bytes to <path>" · "Successfully replaced N block(s) in
 * <path>." — pi's own wording, which the harness fence leaves intact apart from
 * saying the path relative (it appends its notes on a new line) — or undefined
 * for any other text. */
export function reportedWritePath(text: string): string | undefined {
  const m = /^Successfully (?:wrote \d+ bytes to|replaced .*? in) (\S.*?)\.?\s*(?:\n|$)/m.exec(
    text,
  );
  return m?.[1];
}
