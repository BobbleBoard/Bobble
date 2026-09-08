/**
 * When a shell command opens something, say what to do next.
 *
 * the user: "the idea of whatever browser or app it opens something in via terminal
 * (which is a common issue I face) immediately give it the tools it needs and the
 * initial snapshot of whatever app or the browser snapshot of chrome."
 *
 * The failure is quiet and consistent: the model runs `open -a "Google Chrome"
 * https://…`, gets back an empty stdout and a zero exit, and has no idea that a
 * window now exists somewhere it can act on. It either declares success without
 * looking, or falls back to the built-in browser — which is a DIFFERENT browser
 * from the one it just opened, with different cookies and a different page.
 *
 * So a bash result that opened something comes back with a line naming what was
 * opened and which tool sees it. Chrome gets the DOM path (chrome_snapshot);
 * anything else gets computer use (mac_snapshot), which falls back to a
 * screenshot on its own when the app is AX-opaque.
 *
 * Pure string work — the harness appends the note; nothing here touches a bridge.
 */

/** What a shell command opened, if anything. */
export interface OpenedTarget {
  /** The app that now has it — "Google Chrome", "Safari", "Preview", … */
  readonly app: string;
  /** True when the app is Chrome, which we can drive through its DOM. */
  readonly chrome: boolean;
  /** The URL or file it was pointed at, when the command named one. */
  readonly target?: string;
  /** A web page opened via the shell with no browser named — it should have gone
   * to the built-in browser, which the model can actually drive. */
  readonly strayWebPage?: boolean;
}

const CHROME_NAMES = /^(google\s+chrome|chrome|google chrome canary)$/i;

/** Strip one layer of surrounding quotes. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Detect an `open` that handed something to a Mac app.
 *
 * Handles the shapes people actually type:
 *   open -a "Google Chrome" https://x     → Chrome, with a URL
 *   open -a Safari                        → Safari, no target
 *   open https://x                        → the DEFAULT browser (unknown by name)
 *   open ~/notes.pdf                      → whatever owns that file type
 *
 * Deliberately conservative: `open` inside a longer pipeline, or a path that is
 * plainly a directory, is not treated as launching an app to drive.
 */
/**
 * Detect AppleScript that drives a Mac app.
 *
 * `open -a` is not the only shell route into an application, and blocking it
 * only moved the model along to the next one. MEASURED, qwen3.5-9b, asked to
 * use TextEdit: after `open -a` was refused it ran
 * `osascript -e 'tell application "TextEdit" to activate'` and then set the
 * document's text by script. It reported success, the text really was there,
 * and none of it went through the tools this feature exists to provide — while
 * `activate` did the very thing the refusal was protecting against.
 *
 * This is a signpost, not a fence: osascript has legitimate uses and refusing
 * it would be a dead end. What it earns is the same note `open` gets.
 */
export function detectScriptedApp(command: string): OpenedTarget | undefined {
  const m = /\btell\s+application\s+("[^"]+"|'[^']+'|\S+)/i.exec(command);
  if (m === null) return undefined;
  const app = unquote(m[1] ?? '');
  if (app === '' || /^(system\s+events|finder)$/i.test(app)) return undefined;
  return { app, chrome: CHROME_NAMES.test(app) };
}

export function detectOpenedApp(command: string): OpenedTarget | undefined {
  const cmd = command.trim();
  const scripted = /\bosascript\b/.test(cmd) ? detectScriptedApp(cmd) : undefined;
  if (scripted !== undefined) return scripted;
  // Only a command that STARTS with open (or a trivial `cd x && open …` tail).
  const openPart = /(?:^|&&\s*|;\s*)open\s+([^\n]*)$/m.exec(cmd);
  if (openPart === null) return undefined;
  const rest = (openPart[1] ?? '').trim();
  if (rest === '' || rest.startsWith('-')) {
    // `open -a <app>` is the one flag form we care about.
    const withApp = /-a\s+("[^"]+"|'[^']+'|\S+)\s*(.*)$/.exec(rest);
    if (withApp === null) return undefined;
    const app = unquote(withApp[1] ?? '');
    if (app === '') return undefined;
    const target = unquote((withApp[2] ?? '').trim());
    return {
      app,
      chrome: CHROME_NAMES.test(app),
      ...(target !== '' ? { target } : {}),
    };
  }
  // `open <something>` — the system picks the app; we cannot name it.
  const target = unquote(rest.split(/\s+/)[0] ?? '');
  if (target === '' || target === '.' || target === '..') return undefined;
  const isUrl = /^https?:\/\//i.test(target);
  return {
    app: isUrl ? 'your default browser' : 'the app that owns that file',
    chrome: false,
    // A bare URL is the case that should NOT have gone to the shell at all.
    ...(isUrl ? { strayWebPage: true } : {}),
    target,
  };
}

/**
 * The line appended to the bash result.
 *
 * Written as an instruction rather than a description: the model has just been
 * handed a window it cannot see, and the useful thing is the exact next call.
 */
export function openedAppNote(
  opened: OpenedTarget,
  /**
   * How a computer-use tool is actually invoked in this session, or null when
   * it is called by name.
   *
   * The note used to send the model to `use`, on the reasoning that `use` is
   * always advertised. But `use` only reaches the harness's own tools, and the
   * Mac and Chrome tools belong to another extension — so the one instruction
   * this note gives was a dead end, MEASURED on a real run: the model followed
   * it, was told the tool "cannot be called this way", abandoned Mac control
   * and wrote a temp file instead. Name the call that works.
   */
  commandFor?: (toolName: string) => string | null,
): string {
  const what = opened.target !== undefined ? ` (${opened.target})` : '';
  const head = `\n\n[This opened ${opened.app}${what} — a real Mac app, NOT the built-in browser.`;
  /*
   * THE TOOLS ARE ALREADY YOURS. the user: "currently i'm seeing it open safari and
   * chrome, and then just not be able to control the things it opened with bash
   * like that, it needs to be able to control it."
   *
   * Telling it to call `mac_snapshot` was useless while that tool was not in its
   * list — it was being sent after something it could not reach. Naming `use`
   * here closes that: `use` IS advertised, always, so the very next action can
   * drive the window that just opened without a capability round-trip first.
   */
  const call = (tool: string, args: string): string => {
    const command = commandFor?.(tool) ?? null;
    if (command !== null) return `${command} ${args}`.trimEnd();
    return args === '' ? `call ${tool}` : `call ${tool} with ${args.replace(/--/g, '')}`;
  };
  if (opened.chrome) {
    return (
      `${head} Read it through its DOM: ${call('chrome_snapshot', '')}, then act with ` +
      'chrome_click / chrome_type the same way. Do NOT use the built-in browser tools for it — ' +
      'that is a different browser, with different logins and a different page.]'
    );
  }
  if (opened.strayWebPage === true) {
    // the user: "bias it to use the built in browser instead of bash to open safari
    // when no specific is requested." The page is now in a browser this app
    // cannot drive; say so, and point at the tool that would have worked.
    return (
      `${head} A web page opened from the shell lands in a browser you cannot drive. ` +
      `Use browser_navigate("${opened.target ?? ''}") instead — it opens the page in this ` +
      "app's own browser and hands you back the page itself, ready to act on. Do that now " +
      'rather than trying to control what just opened.]'
    );
  }
  return (
    `${head} Look at it now: ${call('mac_snapshot', `--app "${opened.app}"`)}, then act on what ` +
    `it lists (${call('mac_click', '--index N')}, ${call('mac_type', '--index N --text "…"')}). ` +
    'If the app exposes nothing to Accessibility you get a screenshot of its window ' +
    'automatically; read that and act by x,y coordinates.]'
  );
}
