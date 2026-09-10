/**
 * A WRITE THAT IS REALLY A TOOL CALL THAT LOST ITS WAY.
 *
 * MEASURED, matrix run 1 (Qwen3.5-4B, bash-cli, driving Chrome). Four of the
 * model's thirteen calls were these:
 *
 *   write { path: "read_chrome_url.txt", content: "read the URL of Google Chrome" }
 *   write { path: "read_chrome.html",    content: "read the current state of Google Chrome" }
 *
 * That is not a model taking notes. That is a TOOL CALL — "read the URL of
 * Google Chrome" — emitted with no chrome tool in the advertised list to land
 * on, so llama-server's tool-call grammar pinned the name to the nearest one
 * that exists: `write`. intent-bias.ts measured this exact effect four ways and
 * its first conclusion is the one that applies here — THE LOOP IS AN
 * AVAILABILITY PROBLEM, NOT A PREFERENCE PROBLEM. In bash-cli mode the mac and
 * chrome verbs are bash COMMANDS, not advertised tool names, so nothing the
 * grammar can emit corresponds to what the model wants, every single turn.
 *
 * Worse than the dead end itself: those writes SUCCEEDED. The harness already
 * had a redirect for writing-while-driving, but it fired only when the write was
 * refused by the sandbox fence. Land in a writable workspace and the model is
 * told "Successfully wrote 30 bytes" — positive reinforcement for the one action
 * that cannot possibly affect the window the task is in.
 *
 * The test below is deliberately narrow, because a model driving an app may
 * perfectly well have a real file to write: it fires only when the content is a
 * SHORT IMPERATIVE ABOUT THE THING BEING DRIVEN, which is a sentence, not a file.
 */

/** Verbs a coerced call opens with. Deliberately the computer-use vocabulary. */
const INTENT_VERB =
  /^(read|get|check|look|see|view|show|click|press|tap|type|enter|select|choose|open|navigate|go|scroll|find|search|configure|set|switch|close|take|capture|inspect|list)\b/i;

/** Anything with these in it is a real file, whatever else it looks like. */
const FILE_SHAPED =
  /[{}<>=;]|```|^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)|\b(?:def|class|function|import|const|let|var|return)\b/m;

/** Standing in for the app when the model does not name it. */
const THE_TARGET = /\b(?:the (?:app|window|page|tab|screen|browser)|on screen|on-screen)\b/i;

const MAX_CHARS = 200;
const MAX_LINES = 2;

/**
 * Is this `write`/`edit` content a tool call rather than a file?
 *
 * `app` is the app the run is currently driving — the whole judgement is
 * relative to it, since "read the URL of Google Chrome" is only a misdirected
 * call when Chrome is the thing under control.
 */
export function isCoercedToolCall(content: string, app: string | null): boolean {
  if (app === null) return false;
  const body = content.trim();
  if (body === '' || body.length > MAX_CHARS) return false;
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  if (lines.length > MAX_LINES) return false;
  if (FILE_SHAPED.test(body)) return false;
  if (!INTENT_VERB.test(lines[0] ?? '')) return false;
  /* It has to be about the thing being driven. A short imperative that never
     mentions the app is far likelier to be a genuine one-line note. */
  const names = app
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const hay = body.toLowerCase();
  return names.some((n) => hay.includes(n)) || THE_TARGET.test(body);
}

/**
 * What to hand back instead of writing it.
 *
 * The model already said what it wanted in plain words; the only thing missing
 * was a name it could emit. So quote its own sentence back and give it the
 * command that does exactly that — per intent-bias, making the wanted action
 * reachable is what actually moves a model off a loop.
 */
export function coercedWriteRefusal(content: string, app: string, how: string): string {
  const wanted = content.trim().split('\n')[0] ?? '';
  return (
    `Not written — that was a tool call, not a file. You asked to "${wanted}", and putting ` +
    `that sentence on disk does nothing to ${app}. The command that actually does it is ` +
    `${how}. Run that now.`
  );
}
