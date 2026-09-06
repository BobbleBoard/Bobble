/**
 * "It's happening over there."
 *
 * The blind tester, on the worst moment in the app: "The chat froze for 70
 * seconds while the panel filled beautifully; the app was fine and I couldn't
 * tell. Put a line in the chat column: 'Writing your launch plan in the panel
 * →'."
 *
 * She is exactly right about the cause. The chat column was not broken and was
 * not even empty — it said "Editing a file", twice, in a dim collapsed row. What
 * it never said is that the RESULT was arriving somewhere else. Two panes, one
 * of them visibly working, and the one she was reading never mentioned the other.
 *
 * So: while a canvas tab is being written, the chat column carries a live line
 * naming the file and pointing right. Pure so the copy is testable without a
 * renderer.
 */

/** What the canvas is doing right now, as far as the thread needs to know. */
export interface PanelWork {
  /** The streaming tab's title / filename, e.g. "launch-plan.md". */
  name: string;
  /** What kind of surface it is — drives the verb. */
  kind: 'file' | 'code' | 'markdown' | 'html' | 'svg' | 'image' | 'other';
}

/**
 * The line, or null when there is nothing to say.
 *
 * Only ever shown while the turn is live. A finished file is already listed in
 * the chain above with its own open affordance; repeating it as a status line
 * would be a second, staler copy of the same fact.
 */
export function panelWorkLine(work: PanelWork | null, turnStreaming: boolean): string | null {
  if (work === null || !turnStreaming) return null;
  const name = work.name.trim();
  if (name.length === 0) return null;
  const verb = work.kind === 'image' ? 'Drawing' : 'Writing';
  // The arrow is load-bearing: it is the only thing on the line that says WHERE.
  // the user's tester wrote the copy herself — "Writing your launch plan in the
  // panel →" — and the arrow is the half that moves your eye.
  return `${verb} ${name} in the panel →`;
}

/**
 * The tab the line should describe: the one that is actually streaming. More
 * than one can be open; the one being written is the only one that is news.
 */
export function streamingTab<T extends { streaming?: boolean; title?: string; kind?: string }>(
  tabs: readonly T[],
): T | null {
  return tabs.find((t) => t.streaming === true) ?? null;
}
