/**
 * Google Chrome, driven through its DOM instead of its pixels.
 *
 * Computer use sees Chrome the way it sees a game: one big AX-opaque rectangle.
 * Clicking a link means reading a screenshot and guessing coordinates, which is
 * slow, brittle, and the thing the user has been hitting — "mac computer use
 * consistently failing across most apps and areas".
 *
 * Chrome can do better. It exposes `execute javascript` over Apple Events, so we
 * can read the real DOM and act on real elements — the same quality of control
 * the app's built-in browser has, in the user's OWN Chrome, with their sessions
 * and logins. No extension to install, which the user rightly called "a very odd
 * process for a lot of users".
 *
 * THE GATES BELOW ARE ONLY FOR `execute javascript`, and reading this header as
 * if they gated all of Chrome's AppleScript cost months of capability. MEASURED
 * with the flag OFF: `count of tabs`, `title of tab` and `URL of tab` all
 * answer. See chromeTabs at the bottom of this file.
 *
 * TWO GATES, AND WE ASK BEFORE EITHER:
 *  1. Chrome ships with `AllowJavaScriptAppleEvents` off. Turning it on is a
 *     `defaults write` against ANOTHER application's preferences plus a Chrome
 *     restart — we ask first, exactly like the Mac-control consent prompt, and
 *     never write it silently.
 *  2. macOS then asks for Automation permission the first time we script Chrome.
 *     That one is the system's own prompt; we just surface what it means.
 *
 * Everything here shells out; nothing is Electron-aware, so it unit-tests.
 */
import { execFile } from 'node:child_process';

/** Chrome's preference domain and the key that unlocks `execute javascript`. */
export const CHROME_DOMAIN = 'com.google.Chrome';
export const CHROME_JS_KEY = 'AllowJavaScriptAppleEvents';

/** How long any single osascript/defaults call may take. */
const EXEC_TIMEOUT_MS = 15_000;

export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command, never throwing — a failure is a result, not an exception. */
export async function run(file: string, args: readonly string[]): Promise<ExecResult> {
  return await new Promise((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      });
    });
  });
}

/** `defaults read` yields "1"/"0"/"true"/"false", or fails when the key is unset. */
export function parseDefaultsBool(res: ExecResult): boolean {
  if (!res.ok) return false; // key absent ⇒ Chrome's default, which is OFF
  const v = res.stdout.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Is Chrome willing to run JavaScript sent over Apple Events? */
export async function chromeJsAllowed(): Promise<boolean> {
  return parseDefaultsBool(await run('defaults', ['read', CHROME_DOMAIN, CHROME_JS_KEY]));
}

/** Turn it on. The caller MUST have consent before calling this. */
export async function enableChromeJs(): Promise<ExecResult> {
  return await run('defaults', ['write', CHROME_DOMAIN, CHROME_JS_KEY, '-bool', 'true']);
}

/**
 * The AppleScript that runs one JS expression in Chrome's active tab.
 *
 * Built as a string rather than a template so the JS is escaped exactly once, in
 * a place that is tested — an unescaped quote here would silently truncate the
 * script and "work" while doing something else.
 */
export function chromeEvalScript(js: string): string {
  const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Google Chrome" to execute front window's active tab javascript "${escaped}"`;
}

/** What a failed Chrome script means, in words the model can act on. */
export function explainChromeFailure(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('not allowed') || s.includes('-1743') || s.includes('not authorized')) {
    return (
      'macOS has not granted permission to control Chrome. Approve the "Automation" prompt, ' +
      'or enable it in System Settings → Privacy & Security → Automation.'
    );
  }
  if (s.includes('javascript') || s.includes('-2700') || s.includes('executing javascript')) {
    /*
     * AND SAY WHAT TO DO INSTEAD, because the model cannot fix this and must
     * not try. "Allow JavaScript from Apple Events" is off by default and is the
     * user's setting to change; telling a model to enable it is a signpost
     * pointing at nothing, and MEASURED on the user's machine it is off, so every
     * chrome_* call fails this way.
     *
     * The way out is the one a 27B found unaided on the archive.org run — "so I
     * typed the URL into the address bar like a [person]" — while a 4B and a 9B
     * did not, and spent their runs re-trying the blocked route. Chrome is still
     * an app: ⌘L focuses the address bar and it can be typed into.
     */
    return (
      'Chrome is refusing JavaScript from Apple Events (it is off by default, and only ' +
      'the user can turn it on — do NOT try). The chrome_* commands all go through it, ' +
      'so none of them will work in this session. DRIVE CHROME AS AN APP INSTEAD, which ' +
      'needs no setting: mac_key "cmd+l" to focus the address bar, mac_type the URL with ' +
      'submit, then mac_snapshot to read the page. The window title carries the page title. ' +
      "A snapshot of Chrome carries the PAGE'S OWN TEXT, not just its controls — headings, " +
      'prices, labels, whatever is written on it — so you can read a page without a ' +
      'screenshot. Use `find` to jump to a word that is further down it.'
    );
  }
  // macOS spells it "Can’t get window 1" — a curly apostrophe, which the
  // straight-quoted test below never matched (SEEN: the raw AppleScript error
  // reached the model eight times in one run).
  const plain = s.replace(/[\u2018\u2019]/g, "'");
  if (plain.includes("can't get") || plain.includes('front window') || plain.includes('-1719')) {
    return (
      'Chrome has no open window to act on — it is showing its profile picker, or every ' +
      'window is closed. Pick a profile / open a window in Chrome first: `mac snapshot ' +
      '"Google Chrome"` lists the picker\'s buttons to click. Or use the built-in browser ' +
      '(`browser navigate`), which needs none of this.'
    );
  }
  return stderr.length > 0 ? stderr : 'Chrome did not respond to the script.';
}

/**
 * Is Chrome running? Asked BEFORE any `tell application "Google Chrome"`,
 * because AppleScript launches an app it addresses — and a Chrome launched that
 * way comes up in FRONT, profile picker and all, with nobody to hand the focus
 * back. the user: "chrome I know for sure … steal focus upon computer use launch."
 * A Chrome that is not running is launched through the bridge's background
 * launch instead, which watches the focus and returns it.
 */
export async function chromeRunning(): Promise<boolean> {
  return (await chromePid()) !== null;
}

/** Chrome's main process id, or null when it is not running. */
export async function chromePid(): Promise<number | null> {
  const res = await run('pgrep', ['-x', 'Google Chrome']);
  if (!res.ok) return null;
  const pid = Number.parseInt(res.stdout.split('\n')[0] ?? '', 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Run JS in Chrome's active tab and return whatever it evaluated to. */
export async function chromeEval(
  js: string,
): Promise<{ ok: boolean; value: string; error?: string }> {
  const res = await run('osascript', ['-e', chromeEvalScript(js)]);
  if (!res.ok) return { ok: false, value: '', error: explainChromeFailure(res.stderr) };
  return { ok: true, value: res.stdout };
}

/**
 * The in-page script that produces the snapshot.
 *
 * Deliberately the same SHAPE as the built-in browser's: an indexed list of the
 * things you can actually act on, so the model's habits transfer between the two
 * browsers instead of being per-tool trivia. Elements are numbered in document
 * order and that ordering is what `chrome_click` / `chrome_type` address, so a
 * snapshot and the action that follows agree.
 */
export const CHROME_SNAPSHOT_JS = `(function(){
  var sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],[contenteditable=true]';
  var out = [];
  var nodes = document.querySelectorAll(sel);
  for (var i = 0; i < nodes.length && out.length < 200; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    var label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().replace(/\\s+/g,' ').slice(0,80);
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    var extra = '';
    if (el.tagName === 'A' && el.href) extra = ' -> ' + el.href.slice(0,120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) extra += ' (editable)';
    out.push('[' + out.length + '] ' + role + (label ? ' "' + label + '"' : '') + extra);
  }
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\n\\n' + (out.length ? out.join('\\n') : '(no interactive elements found)');
})()`;

/** Address the Nth element the snapshot listed — same selector, same order. */
export function chromeActionJs(index: number, action: 'click' | 'focus', text?: string): string {
  const sel =
    "'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],[contenteditable=true]'";
  const body =
    action === 'click'
      ? 'el.click(); return "clicked " + (el.innerText||el.value||el.tagName).slice(0,60);'
      : `el.focus(); el.value = ${JSON.stringify(text ?? '')}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return "typed into " + el.tagName;`;
  return `(function(){
  var nodes = document.querySelectorAll(${sel});
  var vis = [];
  for (var i=0;i<nodes.length;i++){ var r=nodes[i].getBoundingClientRect(); var s=window.getComputedStyle(nodes[i]); if(r.width&&r.height&&s.visibility!=='hidden'&&s.display!=='none') vis.push(nodes[i]); }
  var el = vis[${Math.max(0, Math.floor(index))}];
  if (!el) return "ERROR: no element [${Math.max(0, Math.floor(index))}] — re-snapshot, the page may have changed";
  ${body}
})()`;
}

// ── tabs, without the JavaScript gate ────────────────────────────────────────

/**
 * THE FLAG ONLY GATES `execute javascript`. Everything else in Chrome's
 * AppleScript dictionary works without it.
 *
 * the user: "again remember this is totally possible (and for chrome possible
 * without asking the user to download an extension, that's not an option)."
 * He was right, and the assumption in this file's own header — that the DOM
 * gate is the gate for all of it — is what hid it. MEASURED against a Chrome
 * with `AllowJavaScriptAppleEvents` OFF:
 *
 *   count of tabs / title of tab / URL of tab   → answered
 *   execute javascript                          → refused
 *
 * So the tab strip is readable with no setting, no restart and no extension —
 * and better than the Accessibility route it replaces, which knew titles but
 * never URLs and could only see the frontmost window.
 */
export interface ChromeTabInfo {
  readonly window: number;
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

/** One record per line, unit-separated, so a title containing a comma or a
 * newline cannot be mistaken for a field or a row boundary. */
const TABS_SCRIPT = `tell application "Google Chrome"
  set out to ""
  repeat with w from 1 to (count of windows)
    set act to active tab index of window w
    repeat with t from 1 to (count of tabs of window w)
      set out to out & w & "\t" & t & "\t" & (act = t) & "\t" & (title of tab t of window w) & "\t" & (URL of tab t of window w) & "\n"
    end repeat
  end repeat
  return out
end tell`;

export function parseChromeTabs(raw: string): ChromeTabInfo[] {
  const out: ChromeTabInfo[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const w = Number(parts[0]);
    const i = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(i)) continue;
    out.push({
      window: w,
      index: i,
      active: (parts[2] ?? '').trim() === 'true',
      title: (parts[3] ?? '').trim(),
      /* A URL cannot contain a tab, so anything after the fourth separator is
         still the URL — rejoined rather than dropped. */
      url: parts.slice(4).join('\t').trim(),
    });
  }
  return out;
}

/** Every open tab in every Chrome window, or null when Chrome will not answer
 * (not running, or Automation permission refused — NOT the JavaScript flag). */
export async function chromeTabs(): Promise<ChromeTabInfo[] | null> {
  // Listing the tabs of a Chrome that is not running is "none" — asking
  // AppleScript would LAUNCH it, in front (see chromeRunning).
  if (!(await chromeRunning())) return null;
  const res = await run('osascript', ['-e', TABS_SCRIPT]);
  if (!res.ok) return null;
  const tabs = parseChromeTabs(res.stdout);
  return tabs.length === 0 ? null : tabs;
}
