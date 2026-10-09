/**
 * THE MAC, AS THE QUICK PANEL SEES IT — and a stand-in for test runs.
 *
 * Everything the panel reads from outside Bobble goes through one interface:
 * the app in front, its selected text, the windows on screen, Finder's
 * selection, the browser's page, the clipboard — and the few things it does:
 * put text back where a selection was, hand the keyboard back, open a System
 * Settings pane.
 *
 * The real one reads through the long-lived `pi-mac` helper (Accessibility and
 * the window server), `osascript` for Finder and the browsers, and Electron's
 * clipboard. The FAKE one is what every test run gets: a probe must never read
 * the person's selection or pasteboard, never trigger a permission prompt, and
 * never move their focus — so under PI_E2E nothing here touches the real Mac,
 * and a probe sets what the fake reports through `quick:debug`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipboard, shell, systemPreferences } from 'electron';
import { macHelperRequest } from '../mac/mac-agent';
import { registerForScreenRecording, SCREEN_RECORDING_SETTINGS_URL } from '../mac/window-capture';
import type { QuickFrontApp, QuickProblem, QuickSystemPane } from './quick-contract';
import type { ScreenWindow } from './region-math';

const execFileAsync = promisify(execFile);

export type Grant = 'granted' | 'denied' | 'unknown';

export interface SelectionRead {
  readonly text: string;
  readonly editable: boolean;
  readonly secure: boolean;
  readonly app: string;
}

export interface BrowserRead {
  readonly app: string;
  readonly url: string;
  readonly title: string;
  readonly text?: string;
  /** Why the page text is missing, when the URL came back without it. */
  readonly textProblem?: QuickProblem;
}

export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: QuickProblem };

export interface QuickMac {
  /** The front app (Bobble included — `isBobble` says so). */
  frontApp(ownPids: readonly number[]): Promise<QuickFrontApp | null>;
  selection(pid: number): Promise<Read<SelectionRead>>;
  /** Ordinary on-screen windows, front to back (Bobble's own excluded). */
  screenWindows(ownPids: readonly number[]): Promise<ScreenWindow[]>;
  replaceSelection(pid: number, text: string): Promise<Read<{ replaced: boolean }>>;
  /** Bring an app to the front (the keyboard goes with it). */
  activate(app: QuickFrontApp): Promise<boolean>;
  /** ⌘V into whatever has the keyboard. */
  pasteKeystroke(): Promise<boolean>;
  accessibility(): Promise<Grant>;
  finderSelection(): Promise<Read<string[]>>;
  browserPage(appName: string): Promise<Read<BrowserRead>>;
  clipboardRead(): Read<{ text?: string; image?: string }>;
  clipboardWrite(text: string): void;
  /** What the clipboard held, so a paste-through can put it back. */
  clipboardSnapshot(): () => void;
  openSystemSettings(pane: QuickSystemPane): Promise<boolean>;
}

const PANE_URLS: Readonly<Record<QuickSystemPane, string>> = {
  'screen-recording': SCREEN_RECORDING_SETTINGS_URL,
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

/** The browsers whose page can be read, by the name macOS shows. Fixed strings only:
 *  an app name is never spliced into a script from anywhere else. */
const SAFARI_LIKE: ReadonlySet<string> = new Set(['Safari', 'Safari Technology Preview']);
const CHROME_LIKE: ReadonlySet<string> = new Set([
  'Google Chrome',
  'Google Chrome Canary',
  'Chromium',
  'Brave Browser',
  'Microsoft Edge',
  'Arc',
  'Vivaldi',
]);

export function isReadableBrowser(appName: string): boolean {
  return SAFARI_LIKE.has(appName) || CHROME_LIKE.has(appName);
}

/** osascript's "not allowed to send Apple events" answer. */
function automationRefused(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}`
      : String(err);
  return /-1743|not allowed|not authori[sz]ed/i.test(text);
}

async function osa(script: string, timeoutMs = 4000): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
  return stdout.replace(/\n$/, '');
}

/** A picture as a data URL, no wider than `maxEdge` — the model reads it either way. */
export function imageDataUrl(img: Electron.NativeImage, maxEdge = 1600): string {
  const { width, height } = img.getSize();
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  const sized =
    scale < 1
      ? img.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'best',
        })
      : img;
  const png = sized.toPNG();
  if (png.length <= 2_500_000) return `data:image/png;base64,${png.toString('base64')}`;
  return `data:image/jpeg;base64,${sized.toJPEG(88).toString('base64')}`;
}

export function createRealMac(): QuickMac {
  let axCache: { at: number; grant: Grant } | null = null;
  return {
    async frontApp(ownPids) {
      const r = await macHelperRequest<{
        ok?: boolean;
        pid?: number;
        app?: string;
        bundleId?: string;
      }>('frontmost', {});
      if (r.ok === false || typeof r.pid !== 'number') return null;
      return {
        pid: r.pid,
        name: r.app ?? '',
        ...(r.bundleId !== undefined && r.bundleId !== '' ? { bundleId: r.bundleId } : {}),
        ...(ownPids.includes(r.pid) ? { isBobble: true } : {}),
      };
    },
    async selection(pid) {
      try {
        const r = await macHelperRequest<{
          ok?: boolean;
          error?: string;
          text?: string;
          editable?: boolean;
          secure?: boolean;
          app?: string;
        }>('selection', { pid });
        if (r.ok === false) {
          return {
            ok: false,
            problem: r.error === 'accessibility' ? { kind: 'accessibility' } : { kind: 'nothing' },
          };
        }
        if (r.secure === true) return { ok: false, problem: { kind: 'secure', app: r.app } };
        return {
          ok: true,
          value: {
            text: r.text ?? '',
            editable: r.editable === true,
            secure: false,
            app: r.app ?? '',
          },
        };
      } catch (err) {
        return { ok: false, problem: { kind: 'failed', detail: String(err) } };
      }
    },
    async screenWindows(ownPids) {
      try {
        const r = await macHelperRequest<{
          windows?: Array<{
            windowId: number;
            pid: number;
            app: string;
            layer: number;
            x: number;
            y: number;
            w: number;
            h: number;
          }>;
        }>('screenWindows', { excludePids: [...ownPids] });
        return (r.windows ?? []).map((w) => ({
          windowId: w.windowId,
          pid: w.pid,
          app: w.app,
          layer: w.layer,
          bounds: { x: w.x, y: w.y, width: w.w, height: w.h },
        }));
      } catch {
        return [];
      }
    },
    async replaceSelection(pid, text) {
      try {
        const r = await macHelperRequest<{
          ok?: boolean;
          error?: string;
          replaced?: boolean;
          secure?: boolean;
        }>('replaceSelection', { pid, text });
        if (r.ok === false) {
          return {
            ok: false,
            problem: r.error === 'accessibility' ? { kind: 'accessibility' } : { kind: 'failed' },
          };
        }
        if (r.secure === true) return { ok: false, problem: { kind: 'secure' } };
        return { ok: true, value: { replaced: r.replaced === true } };
      } catch (err) {
        return { ok: false, problem: { kind: 'failed', detail: String(err) } };
      }
    },
    async activate(app) {
      try {
        const r = await macHelperRequest<{ ok?: boolean }>('focus', {
          app: app.bundleId ?? app.name,
        });
        return r.ok === true;
      } catch {
        return false;
      }
    },
    async pasteKeystroke() {
      try {
        const r = await macHelperRequest<{ ok?: boolean }>('key', { combo: 'cmd+v' });
        return r.ok !== false;
      } catch {
        return false;
      }
    },
    async accessibility() {
      if (process.platform !== 'darwin') return 'unknown';
      if (axCache !== null && Date.now() - axCache.at < 15_000) return axCache.grant;
      let grant: Grant = 'unknown';
      try {
        // The HELPER reads selections, so its answer is the one that counts.
        const r = await macHelperRequest<{ accessibility?: boolean }>('check', {});
        grant = r.accessibility === true ? 'granted' : 'denied';
      } catch {
        grant = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
      }
      axCache = { at: Date.now(), grant };
      return grant;
    },
    async finderSelection() {
      try {
        const out = await osa(
          [
            'tell application "Finder"',
            '  set picked to selection as alias list',
            '  set out to ""',
            '  repeat with f in picked',
            '    set out to out & POSIX path of f & linefeed',
            '  end repeat',
            '  return out',
            'end tell',
          ].join('\n'),
        );
        const paths = out
          .split('\n')
          .map((p) => p.trim())
          .filter((p) => p !== '');
        if (paths.length === 0) return { ok: false, problem: { kind: 'nothing', app: 'Finder' } };
        return { ok: true, value: paths };
      } catch (err) {
        return {
          ok: false,
          problem: automationRefused(err)
            ? { kind: 'automation', app: 'Finder' }
            : { kind: 'failed', app: 'Finder' },
        };
      }
    },
    async browserPage(appName) {
      const safari = SAFARI_LIKE.has(appName);
      if (!safari && !CHROME_LIKE.has(appName)) {
        return { ok: false, problem: { kind: 'unsupported', app: appName } };
      }
      // `appName` is one of the fixed names above, so this splice is a constant.
      const tab = safari ? 'current tab of front window' : 'active tab of front window';
      const titleProp = safari ? 'name' : 'title';
      let url: string;
      let title: string;
      try {
        const out = await osa(
          `tell application "${appName}" to return (URL of ${tab}) & linefeed & (${titleProp} of ${tab})`,
        );
        const [u = '', ...rest] = out.split('\n');
        url = u.trim();
        title = rest.join(' ').trim();
      } catch (err) {
        return {
          ok: false,
          problem: automationRefused(err)
            ? { kind: 'automation', app: appName }
            : { kind: 'nothing', app: appName },
        };
      }
      if (url === '') return { ok: false, problem: { kind: 'nothing', app: appName } };
      try {
        const js = 'document.body ? document.body.innerText : ""';
        const text = await osa(
          safari
            ? `tell application "${appName}" to do JavaScript "${js.replace(/"/g, '\\"')}" in ${tab}`
            : `tell application "${appName}" to execute ${tab} javascript "${js.replace(/"/g, '\\"')}"`,
          6000,
        );
        return { ok: true, value: { app: appName, url, title, text } };
      } catch {
        // JavaScript from Apple Events is off by default in both browsers; the
        // address and title still came back, and the panel says how to get more.
        return {
          ok: true,
          value: {
            app: appName,
            url,
            title,
            textProblem: {
              kind: 'automation',
              app: appName,
              detail: `To include the page's text, turn on "Allow JavaScript from Apple Events" in ${appName}'s developer settings.`,
            },
          },
        };
      }
    },
    clipboardRead() {
      const image = clipboard.readImage();
      if (!image.isEmpty()) return { ok: true, value: { image: imageDataUrl(image) } };
      const text = clipboard.readText();
      if (text.trim() !== '') return { ok: true, value: { text } };
      return { ok: false, problem: { kind: 'nothing', app: 'the clipboard' } };
    },
    clipboardWrite(text) {
      clipboard.writeText(text);
    },
    clipboardSnapshot() {
      const text = clipboard.readText();
      const image = clipboard.readImage();
      return () => {
        if (!image.isEmpty()) clipboard.writeImage(image);
        else clipboard.writeText(text);
      };
    },
    async openSystemSettings(pane) {
      if (pane === 'screen-recording') await registerForScreenRecording();
      try {
        await shell.openExternal(PANE_URLS[pane]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── the stand-in ────────────────────────────────────────────────────────────

/** What the fake Mac reports; a probe changes it through `quick:debug set-mac`. */
export interface FakeMacState {
  front: QuickFrontApp | null;
  selection: { text: string; editable: boolean; secure?: boolean } | null;
  accessibility: Grant;
  clipboard: { text?: string; image?: string };
  finder: string[] | 'denied';
  browser: { url: string; title: string; text?: string } | null;
  windows: ScreenWindow[];
  /** Whether the app takes text back through Accessibility (else the paste path runs). */
  axReplace: boolean;
}

export interface FakeMacCall {
  readonly op: string;
  readonly detail?: unknown;
}

export function defaultFakeMacState(): FakeMacState {
  return {
    front: { pid: 4242, name: 'TextEdit', bundleId: 'com.apple.TextEdit', windowId: 501 },
    selection: null,
    accessibility: 'granted',
    clipboard: {},
    finder: [],
    browser: null,
    windows: [
      {
        windowId: 501,
        pid: 4242,
        app: 'TextEdit',
        layer: 0,
        bounds: { x: 180, y: 120, width: 760, height: 520 },
      },
      {
        windowId: 502,
        pid: 4343,
        app: 'Safari',
        layer: 0,
        bounds: { x: 520, y: 220, width: 900, height: 600 },
      },
      {
        windowId: 503,
        pid: 4444,
        app: 'Notes',
        layer: 0,
        bounds: { x: 60, y: 300, width: 600, height: 480 },
      },
    ],
    axReplace: true,
  };
}

export function createFakeMac(): QuickMac & {
  readonly state: FakeMacState;
  readonly calls: FakeMacCall[];
  set(patch: Partial<FakeMacState>): void;
} {
  const state = defaultFakeMacState();
  const calls: FakeMacCall[] = [];
  return {
    state,
    calls,
    set(patch) {
      Object.assign(state, patch);
    },
    async frontApp(ownPids) {
      if (state.front === null) return null;
      return ownPids.includes(state.front.pid) ? { ...state.front, isBobble: true } : state.front;
    },
    async selection() {
      if (state.accessibility !== 'granted')
        return { ok: false, problem: { kind: 'accessibility' } };
      if (state.selection?.secure === true) {
        return { ok: false, problem: { kind: 'secure', app: state.front?.name } };
      }
      return {
        ok: true,
        value: {
          text: state.selection?.text ?? '',
          editable: state.selection?.editable === true,
          secure: false,
          app: state.front?.name ?? '',
        },
      };
    },
    async screenWindows(ownPids) {
      return state.windows.filter((w) => !ownPids.includes(w.pid));
    },
    async replaceSelection(_pid, text) {
      if (state.accessibility !== 'granted')
        return { ok: false, problem: { kind: 'accessibility' } };
      calls.push({ op: 'replace-selection', detail: { text, replaced: state.axReplace } });
      return { ok: true, value: { replaced: state.axReplace } };
    },
    async activate(app) {
      calls.push({ op: 'activate', detail: app.name });
      return true;
    },
    async pasteKeystroke() {
      calls.push({ op: 'paste' });
      return true;
    },
    async accessibility() {
      return state.accessibility;
    },
    async finderSelection() {
      if (state.finder === 'denied')
        return { ok: false, problem: { kind: 'automation', app: 'Finder' } };
      if (state.finder.length === 0)
        return { ok: false, problem: { kind: 'nothing', app: 'Finder' } };
      return { ok: true, value: [...state.finder] };
    },
    async browserPage(appName) {
      if (!isReadableBrowser(appName))
        return { ok: false, problem: { kind: 'unsupported', app: appName } };
      if (state.browser === null) return { ok: false, problem: { kind: 'nothing', app: appName } };
      return { ok: true, value: { app: appName, ...state.browser } };
    },
    clipboardRead() {
      if (state.clipboard.image !== undefined)
        return { ok: true, value: { image: state.clipboard.image } };
      if (state.clipboard.text !== undefined && state.clipboard.text !== '') {
        return { ok: true, value: { text: state.clipboard.text } };
      }
      return { ok: false, problem: { kind: 'nothing', app: 'the clipboard' } };
    },
    clipboardWrite(text) {
      calls.push({ op: 'clipboard-write', detail: text });
      state.clipboard = { text };
    },
    clipboardSnapshot() {
      const before = { ...state.clipboard };
      return () => {
        state.clipboard = before;
        calls.push({ op: 'clipboard-restore' });
      };
    },
    async openSystemSettings(pane) {
      calls.push({ op: 'open-system-settings', detail: pane });
      return true;
    },
  };
}
