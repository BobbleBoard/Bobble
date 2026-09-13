/**
 * The absolute path a write/edit tool RESULT names — the one place the disk's
 * truth is stated. A call's own `path` is whatever the model typed, relative
 * to a root only the tools know for sure; the row in the thread and the tab
 * in the canvas both key on this once it is in. No imports, so both sides of
 * the activity code can use it without a cycle.
 */
/** "Successfully wrote N bytes to /abs" · "Successfully replaced N block(s) in
 * /abs" — pi's own wording, which the harness fence leaves intact (it appends
 * its notes on a new line) — or undefined for any other text. */
export function reportedWritePath(text: string): string | undefined {
  const m = /^Successfully (?:wrote \d+ bytes to|replaced .*? in) (\/\S.*?)\s*(?:\n|$)/m.exec(text);
  return m?.[1];
}
