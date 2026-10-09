/**
 * ONE TAB, "Activity" — the chat's answer to tab spam.
 *
 * The user, round 21: "can't have tab spam when the model does a lot of actions, so
 * it needs one tab, 'Activity' that opens and shows what the model is doing at
 * any given moment … if a new file is edited, it shows that file, if a new file
 * is written it shows that, doing something in the browser, this tab shows that,
 * bash command? … shows up in a terminal, that activity tab just switches to
 * these, keeping the state of past ones … everything persists."
 *
 * WHAT WAS THERE BEFORE. Three routers, each opening its own tab: a file tab per
 * path (`file:/abs/path`), a mirror terminal per interactive command
 * (`term:<callId>`), a browser tab of its own. A turn that wrote four files and
 * ran three commands left seven tabs, every one of which had taken focus as it
 * appeared. This replaces all three for the ordinary chat.
 *
 * THE SHAPE IS NOT NEW. The corp router (corp-canvas-routing.ts) already does
 * exactly this for a multi-agent run, down to the name; the user asked for the same
 * thing in the normal chat, so this is deliberately its twin and shares its
 * primitives (`mirrorCommandText`, `shortCommandTitle` from ./agent-surfaces).
 * There is no third activity concept here — there are two callers of one idea.
 *
 * ── THE THREE RULES ────────────────────────────────────────────────────────
 *
 * NEWEST WINS, ACROSS KINDS. Deciding "a file if there is one, else a terminal"
 * pins the tab to whichever surface the model happened to use first and leaves
 * it there while it does something else. The question the tab answers is what is
 * happening NOW, so the most recent tool call decides — whatever kind it is.
 *
 * IT OPENS ONCE AND THEN GOES QUIET. The first tool call with something to show
 * creates the tab, focuses it and opens the rail. Every change after that is an
 * `updateTab` on the same id: the tab morphs where it stands, and a user who has
 * clicked onto another tab is never dragged off it.
 *
 * EVERYTHING PERSISTS, and it does so BY CONSTRUCTION rather than by caching.
 * Every surface here is derived from the whole message history, so the terminal
 * is every shell command this thread has run — `ls -la` and its output still
 * above the command being typed underneath — and switching away and back
 * re-derives exactly what was there. The one piece of real state is the xterm
 * itself, which native-surfaces keeps per tab id and re-appends on remount (it
 * is detached, never destroyed), so the mirror APPENDS as output arrives instead
 * of rebuilding its screen.
 *
 * ── WHAT IT DELIBERATELY DOES NOT ROUTE ────────────────────────────────────
 *
 * Media generation. Image / video / audio tools render inline in the thread as
 * the big card their studio shows (queue item 5) — they never reach the canvas,
 * so no generation tool appears in the arbitration below.
 */
import type { CanvasController, CanvasTabKind, CanvasTabSpec } from '@pi-desktop/canvas';
import type { ChatMsg, ContentBlock } from '@pi-desktop/engine';
import { useEffect, useReducer, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { useCorpStore } from '../../state/corp-store';
import { usePiStore } from '../../state/pi-slice';
import { useProjectStore } from '../../state/project-store';
import { toolStepKind } from '../activity-mapping';
import { cliCommandLabel } from '../cli-command-label';
import { useHarnessStatus } from '../harness-status';
import { COMMAND_KEYS, partialJsonString } from '../partial-json';
import { firstCommandWord, isTerminalCommand } from './activity-cli';
import { computerUseLabel, isComputerUseCall } from './activity-computer-use';
// The tab's identity lives in a leaf module so the browser bridge can ask which
// tab to drive without importing this one (and dragging the file surface with
// it). Re-exported below: this module is where it is used.
import { ACTIVITY_TAB_KEY, ACTIVITY_TITLE } from './activity-tab';
import { mirrorCommandText, shortCommandTitle } from './agent-surfaces';
import { getDrivenBrowserTab, subscribeDrivenBrowserTab } from './browser-agent-tab';
import { pdFileUrl, previewKindForExt } from './file-preview';
import {
  fileArtifact,
  fileArtifactFromText,
  fileBreadcrumb,
  presentEdit,
  unreadableFileArtifact,
} from './file-tabs';
import { basename, detectFileWrites, dirname, type FileWriteEvent } from './file-writes';
import { macMonitorFeed } from './mac-monitor';

export { ACTIVITY_TAB_KEY, ACTIVITY_TITLE };

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;

/** One shell command in the Activity terminal: its line, its output, its state. */
export interface ActivityCommand {
  callId: string;
  command: string;
  output: string;
  /** No tool result yet — the command is still running. */
  running: boolean;
  /** The tool reported an error (non-zero exit, refused) — its output paints red. */
  failed: boolean;
  /** The arguments have all arrived and the tool is running the command — the
   * mirror presses Enter (see mirrorCommandText). */
  executing?: boolean;
}

/**
 * What the tab should BE right now. `at` is the position of the deciding tool
 * call in the thread, which is all "newest wins" needs.
 */
export type ActivityFocus =
  | { kind: 'terminal'; at: number; command: ActivityCommand }
  | { kind: 'file'; at: number; write: FileWriteEvent }
  | { kind: 'browser'; at: number; label: string }
  /**
   * The model is driving an app on the Mac (`mac …` / `chrome …`, or the
   * mac_* tools). The user: "activity tab should be computer use page if the
   * latest command is something like 'mac snapshot'". The tab becomes the
   * live monitor of the controlled app — the same surface the phantom cursor
   * is painted on — and, newest wins, goes back to the terminal or a file when
   * the model does.
   */
  | { kind: 'computer-use'; at: number; label: string };

/** Everything the Activity tab renders from: the whole terminal history, plus
 * whichever surface the newest call points at. */
export interface ActivityStream {
  /** Every shell command the thread has run, oldest→newest — the scrollback. */
  commands: ActivityCommand[];
  /** The newest thing worth showing; undefined before anything has happened. */
  focus?: ActivityFocus;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The command a bash call is running, INCLUDING while its arguments are still
 * streaming — the user wants the previous command's output visible "above this next
 * one as it's being typed", which only means anything if the line appears as it
 * arrives rather than when it completes.
 */
function commandOf(block: ToolCallBlock): string | undefined {
  if (toolStepKind(block.name) !== 'bash') return undefined;
  const finalized = str(block.arguments?.command);
  if (finalized !== undefined) return finalized;
  const buf = block.argsText;
  if (buf === undefined || buf.length === 0) return undefined;
  return partialJsonString(buf, COMMAND_KEYS)?.value;
}

/** The browser step kinds — a call in any of them means "look at the browser". */
const BROWSER_KINDS = new Set([
  'browser-navigate',
  'browser-click',
  'browser-type',
  'browser-read',
]);

/** A short human label for a browser call: the site when we can name one, else
 * the verb. It rides in the tab's subtitle, so it has to fit in a tab. */
export function browserLabel(block: ToolCallBlock): string {
  return browserLabelFor(toolStepKind(block.name), str(block.arguments?.url));
}

function browserLabelFor(kind: string | undefined, url: string | undefined): string {
  if (url !== undefined) {
    try {
      return new URL(url).host || url;
    } catch {
      return url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
    }
  }
  if (kind === 'browser-click') return 'Clicking';
  if (kind === 'browser-type') return 'Typing';
  if (kind === 'browser-read') return 'Reading the page';
  return 'Browsing';
}

/**
 * The browser call a bash line IS, in tool-CLI mode — `browser click 4`,
 * `browser navigate <url>`, and the `open <url>` the shell wrapper turns into
 * one. Read through the same table the chat's activity rows use, so the tab
 * and the row can never disagree about what a line was.
 */
function cliBrowserFocus(command: string | undefined): { kind: string; url?: string } | null {
  const cli = cliCommandLabel(command);
  if (cli?.kind === undefined || !cli.kind.startsWith('browser-')) return null;
  return { kind: cli.kind, ...(cli.url === undefined ? {} : { url: cli.url }) };
}

/**
 * Fold the thread into {@link ActivityStream}: every shell command in order, and
 * the newest file / terminal / browser call.
 *
 * A bash line that REDIRECTS into a file (`cat > notes.md`) is detected by both
 * halves — `detectFileWrites` sees the write, this sees the command. The file
 * wins the tie, because what the user asked for was the file, and the command is
 * still in the terminal's scrollback either way.
 */
/**
 * Commands that only LOOK. When the turn is over and the last thing the model
 * did was one of these, the tab has nothing to show for it but a listing — and
 * whatever it was working on is what the person wants back.
 */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'ls',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'rg',
  'find',
  'wc',
  'file',
  'stat',
  'pwd',
  'echo',
  'which',
  'type',
  'tree',
  'du',
  'df',
  'diff',
  'xxd',
  'hexdump',
]);

export function isReadOnlyCommand(command: string): boolean {
  const word = firstCommandWord(command);
  return word !== undefined && READ_ONLY_COMMANDS.has(word);
}

export interface DetectActivityOptions {
  /**
   * The turn is over — nothing streaming, nothing running. SEEN (m03 in the
   * canvas assessment): a page rendered in the Activity tab, the user asked
   * for a change, the model edited the file and then ran `cat index.html` to
   * check it — and the tab stayed on the `cat` output for good. "Newest wins"
   * is right WHILE the model works; once it has stopped, a look-only command
   * at the end is noise, and the tab settles back on the newest thing that was
   * actually made or shown.
   */
  readonly settled?: boolean;
  /** Call ids the harness reports as executing (the store's runningToolCalls). */
  readonly executing?: ReadonlyArray<string>;
}

export function detectActivity(
  messages: ChatMsg[],
  partials: Readonly<Record<string, string>> = {},
  cwd?: string,
  opts: DetectActivityOptions = {},
): ActivityStream {
  const resultByCall = new Map<string, string>();
  const failedCalls = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'toolResult') {
      resultByCall.set(m.toolCallId, m.text);
      if (m.isError) failedCalls.add(m.toolCallId);
    }
  }

  const commands: ActivityCommand[] = [];
  const positionOf = new Map<string, number>();
  let at = 0;
  let terminalFocus: ActivityFocus | undefined;
  let browserFocus: ActivityFocus | undefined;
  let computerUseFocus: ActivityFocus | undefined;

  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    for (const block of m.blocks) {
      if (block.type !== 'toolCall') continue;
      at += 1;
      positionOf.set(block.id, at);

      if (BROWSER_KINDS.has(toolStepKind(block.name))) {
        browserFocus = { kind: 'browser', at, label: browserLabel(block) };
        continue;
      }
      const rawCommand = block.name === 'bash' ? commandOf(block) : undefined;
      /*
       * THE SAME CALL IN ITS CLI CLOTHES. In tool-CLI mode `browser click 4`
       * arrives as a bash line, and this loop saw no browser in it at all — so
       * while the bridge morphed the tab into the page, this pass, still
       * holding the newest thing it recognised (an `open <url>` terminal line),
       * morphed it straight back. The user: "the activity panel doesn't focus the
       * working browser tab … doesn't show the user anything for the actual
       * browser actions".
       */
      const cliBrowser = cliBrowserFocus(rawCommand);
      if (cliBrowser !== null) {
        browserFocus = {
          kind: 'browser',
          at,
          label: browserLabelFor(cliBrowser.kind, cliBrowser.url),
        };
        continue;
      }
      if (isComputerUseCall(block.name, rawCommand)) {
        computerUseFocus = {
          kind: 'computer-use',
          at,
          label: computerUseLabel(block.name, rawCommand),
        };
        continue;
      }

      const command = rawCommand ?? commandOf(block);
      if (command === undefined || !isTerminalCommand(command)) continue;
      const output = resultByCall.get(block.id);
      const entry: ActivityCommand = {
        callId: block.id,
        command,
        output: output ?? partials[block.id] ?? '',
        running: output === undefined,
        failed: failedCalls.has(block.id),
        executing: output === undefined && (opts.executing ?? []).includes(block.id),
      };
      commands.push(entry);
      terminalFocus = { kind: 'terminal', at, command: entry };
    }
  }

  let fileFocus: ActivityFocus | undefined;
  for (const write of detectFileWrites(messages, cwd)) {
    // A refused write is not a file (it is flagged so the file-tab hook can
    // close what it opened); the Activity tab has nothing to show for it.
    if (write.failed === true) continue;
    const pos = positionOf.get(write.callId) ?? 0;
    if (fileFocus === undefined || pos >= fileFocus.at) {
      fileFocus = { kind: 'file', at: pos, write };
    }
  }

  // Newest wins; a tie between a file and the command that wrote it goes to the
  // file (`>=` for the file, `>` for the rest).
  let focus: ActivityFocus | undefined;
  for (const candidate of [terminalFocus, browserFocus, computerUseFocus]) {
    if (candidate !== undefined && (focus === undefined || candidate.at > focus.at)) {
      focus = candidate;
    }
  }
  if (fileFocus !== undefined && (focus === undefined || fileFocus.at >= focus.at)) {
    focus = fileFocus;
  }
  if (
    opts.settled === true &&
    focus?.kind === 'terminal' &&
    !focus.command.running &&
    isReadOnlyCommand(focus.command.command)
  ) {
    const made = [fileFocus, browserFocus, computerUseFocus]
      .filter((c): c is ActivityFocus => c !== undefined)
      .sort((a, b) => b.at - a.at)[0];
    if (made !== undefined) focus = made;
  }
  return { commands, ...(focus !== undefined ? { focus } : {}) };
}

/**
 * The whole terminal, as one xterm buffer: every command this thread has run,
 * with its output, in order.
 *
 * This is the persistence the user asked for, and it is why the mirror is built from
 * ALL the commands rather than the current one. The text only ever grows at the
 * end, which is what lets native-surfaces APPEND the new characters instead of
 * resetting the screen — so the scroll position, the earlier commands and their
 * output all survive the next command being typed underneath them.
 */
export function activityMirrorText(commands: readonly ActivityCommand[], cwd?: string): string {
  return commands
    .map((c) =>
      mirrorCommandText(c.command, c.output, c.running, cwd, {
        failed: c.failed,
        executing: c.executing,
      }),
    )
    .join('\n');
}

function extname(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * The breadcrumb for a file the Activity tab is showing, capped at three
 * segments.
 *
 * `fileBreadcrumb` returns EVERY segment when the file is outside the session
 * cwd, and in a 440px rail a nine-segment absolute path renders as a row of
 * ellipses that names nothing at all. The tail — the folder and the file — is
 * what a person actually reads off it, so that is what survives the cap. A path
 * already inside the project ("proj / src / app.ts") is unchanged.
 */
function activityBreadcrumb(absPath: string, cwd: string | undefined): string[] {
  const full = fileBreadcrumb(absPath, cwd);
  return full.length > 3 ? full.slice(-3) : full;
}

/**
 * The tab spec for the current activity — its kind, what it is pointed at, and
 * the label under "Activity" that says which file or command it is.
 *
 * Deliberately WITHOUT the file's content: text comes from disk (or from the
 * tool's own arguments) in the hook below, asynchronously, and folding that into
 * a pure function would make it neither pure nor complete. What is here is
 * everything the tab needs to be the right SHAPE.
 */
export function activitySpec(stream: ActivityStream, cwd?: string): CanvasTabSpec | undefined {
  const focus = stream.focus;
  if (focus === undefined) return undefined;
  const base = { key: ACTIVITY_TAB_KEY, title: ACTIVITY_TITLE } as const;

  if (focus.kind === 'terminal') {
    return {
      ...base,
      kind: 'terminal',
      subtitle: shortCommandTitle(focus.command.command),
      data: { mirror: true, mirrorText: activityMirrorText(stream.commands, cwd) },
    };
  }
  if (focus.kind === 'browser') {
    return { ...base, kind: 'browser', subtitle: focus.label };
  }
  if (focus.kind === 'computer-use') {
    // The feed (the live frames) is attached by the hook: it is app state,
    // and this stays a pure function of the thread.
    return { ...base, kind: 'computer-use', subtitle: focus.label };
  }

  const path = focus.write.path;
  const preview = previewKindForExt(extname(basename(path)));
  // A binary modality the model wrote (a png, a pdf): show it as the picture /
  // document it is rather than as mojibake — but only once the write finished,
  // since half a png renders as a broken image.
  if (preview !== null && !focus.write.running) {
    return {
      ...base,
      kind: preview.kind as CanvasTabKind,
      subtitle: basename(path),
      filePath: path,
      breadcrumb: activityBreadcrumb(path, cwd),
      mediaSrc: `${pdFileUrl(path)}?v=${encodeURIComponent(focus.write.callId)}`,
      mediaType: preview.mediaType,
    };
  }
  return {
    ...base,
    kind: 'file',
    subtitle: basename(path),
    filePath: path,
    breadcrumb: activityBreadcrumb(path, cwd),
    streaming: focus.write.running,
  };
}

// ── the app side: disk reads, then the one tab ───────────────────────────────

/** Same `?piE2E=1` opt-in the other canvas hooks use — skips the real
 * sips/duti shell-out so probes stay fast and deterministic. */
const IS_E2E = new URLSearchParams(window.location.search).has('piE2E');

type ReadFileResult = {
  text: string | null;
  truncated: boolean;
  tooLarge: boolean;
  binary: boolean;
  bytes: number;
  reason?: 'missing' | 'not-allowed' | 'folder' | 'unreadable';
};

/** True when a read carries something DISPLAYABLE — real text (an empty file
 * reads as `''`, which counts) or a binary / too-large notice. A bare
 * `{ text: null }` means the read failed and must never blank a filled tab. */
function readHasContent(read: ReadFileResult | null): read is ReadFileResult {
  return read !== null && (read.text !== null || read.binary || read.tooLarge);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a file, retrying while it momentarily reads as MISSING. A just-written
 * file can lag its tool result by a beat (buffered write / atomic rename) and a
 * single read landing in that gap otherwise leaves the tab blank for good.
 */
async function readFileSettled(absPath: string, attempts = 3): Promise<ReadFileResult | null> {
  let last: ReadFileResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await window.piDesktop.invoke('fs:read-file', { path: absPath });
    } catch {
      last = null;
    }
    if (readHasContent(last)) return last;
    if (attempt < attempts - 1) await delay(120 * (attempt + 1));
  }
  return last;
}

/** Fetch the system apps that can open this file, for the operation bar's
 * "Open ▾" split button. Best-effort; skipped under E2E. */
async function hydrateOpenApps(
  controller: CanvasController,
  tabId: string,
  absPath: string,
): Promise<void> {
  if (IS_E2E) return;
  try {
    const res = await window.piDesktop.invoke('canvas:list-open-apps', { path: absPath });
    const tab = controller.getState().tabs.find((t) => t.id === tabId);
    if (tab === undefined || tab.filePath !== absPath) return;
    const apps = res.apps;
    const defaultApp =
      res.defaultAppId !== null ? apps.find((a) => a.id === res.defaultAppId) : undefined;
    controller.updateTab(tab.id, { openApps: apps, ...(defaultApp ? { defaultApp } : {}) });
  } catch {
    // best-effort — "Open" still opens the OS default.
  }
}

/**
 * Apply a spec to the one Activity tab.
 *
 * A KIND CHANGE REPLACES THE WHOLE TAB, carrying the new spec wholesale so no
 * stale field rides along (a `filePath` left on a terminal, a `mirrorText` left
 * on a file). Same kind: patch only what actually changed, so an unchanged tick
 * does not re-commit canvas state and re-render every surface twenty times a
 * second. The id is preserved either way — that is what makes it a morph rather
 * than a new tab, and it is what keeps the xterm and any native view alive.
 *
 * Exported for the test: this is the persistence model, not a detail.
 */
export function morphActivityTab(
  controller: CanvasController,
  spec: CanvasTabSpec,
): { created: boolean; id: string } {
  const existing = controller.getState().tabs.find((t) => t.key === ACTIVITY_TAB_KEY);
  if (existing === undefined) {
    return { created: true, id: controller.upsertTab(ACTIVITY_TAB_KEY, spec) };
  }
  if (existing.kind !== spec.kind || existing.filePath !== spec.filePath) {
    /*
     * Repointing at something else clears what the last thing left behind:
     * content, a diff, a motion, a media source. Without this, a file tab that
     * becomes a DIFFERENT file shows the previous file's text under the new
     * file's name for as long as the disk read takes — which reads as the model
     * having written the wrong thing.
     */
    controller.updateTab(existing.id, {
      artifact: undefined,
      diff: undefined,
      editAnim: undefined,
      mediaSrc: undefined,
      mediaType: undefined,
      fileTree: undefined,
      openApps: undefined,
      defaultApp: undefined,
      streaming: undefined,
      subtitle: undefined,
      filePath: undefined,
      breadcrumb: undefined,
      data: undefined,
      macMonitor: undefined,
      ...spec,
      title: ACTIVITY_TITLE,
    });
    return { created: false, id: existing.id };
  }
  const patch: Record<string, unknown> = {};
  if (existing.subtitle !== spec.subtitle) patch.subtitle = spec.subtitle;
  if (spec.streaming !== undefined && existing.streaming !== spec.streaming) {
    patch.streaming = spec.streaming;
  }
  if (spec.mediaSrc !== undefined && existing.mediaSrc !== spec.mediaSrc) {
    patch.mediaSrc = spec.mediaSrc;
  }
  if (spec.data !== undefined && existing.data?.mirrorText !== spec.data.mirrorText) {
    patch.data = spec.data;
  }
  if (spec.macMonitor !== undefined && existing.macMonitor !== spec.macMonitor) {
    patch.macMonitor = spec.macMonitor;
  }
  if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
  return { created: false, id: existing.id };
}

/**
 * Drive the one Activity tab off the chat's message stream.
 *
 * Mounted in CanvasTabsPanel in place of the per-path file router and the
 * per-command terminal router. Inert during a corp run (the corp router owns its
 * own activity tab) and while another chat streams in the background (its work
 * must not appear in the canvas of the chat being looked at).
 */
export function useActivityCanvasRouting(controller: CanvasController): void {
  const messages = usePiStore((s) => s.messages) as ChatMsg[];
  const partials = usePiStore((s) => s.toolOutputPartials);
  const executing = usePiStore((s) => s.runningToolCalls);
  // The folder the TOOLS resolve a relative path against — the chat's working
  // folder, published by the harness — not pi's cwd, which can be its parent.
  const piCwd = usePiStore((s) => s.session?.cwd ?? undefined);
  const workspaceRoot = useHarnessStatus()?.workspaceRoot ?? null;
  const cwd = workspaceRoot ?? piCwd;
  const bgStreaming = usePiStore((s) => s.bgRun?.streaming === true);
  const streaming = usePiStore((s) => s.agent.isStreaming);
  const corpActive = useCorpStore((s) => s.taskId !== null);
  /* Every session boundary — new chat, chat switch, rehydrate — bumps this. It
   * is the reset signal for everything below: the open-once latch, and the
   * per-call bookkeeping, whose ids belong to a thread that is no longer on
   * screen. Without it, switching to a chat whose canvas snapshot has no
   * Activity tab would leave the latch set and the tab would never come back. */
  const sessionEpoch = usePiStore((s) => s.sessionEpoch);

  /*
   * The tab is opened ONCE and then only updated. The latch is released when a
   * NEW user turn begins, so an Activity tab the user closed comes back for the
   * next request — "the canvas opens to this activity tab on the first relevant
   * tool call" is per request, not once per lifetime — while a tab they merely
   * clicked away from is never dragged back in front of them.
   */
  const opened = useRef(false);
  const userTurns = useRef(-1);
  /** Paths whose settled on-disk read has already been applied, by call id. */
  const finalized = useRef<Set<string>>(new Set());
  /** Per-edit bookkeeping for the animation: the file as it stood BEFORE the
   * call (read while its arguments were still arriving, so still pre-edit),
   * which reads are in flight, and which motions have been handed over. */
  const editBase = useRef<Map<string, string>>(new Map());
  const editReading = useRef<Set<string>>(new Set());
  /*
   * ASKED ALREADY — separate from "still asking", and the difference matters.
   *
   * With only the in-flight set, a file that CANNOT be read span forever: the
   * read fails, clears the in-flight mark, nudges this pass, and the pass — not
   * having a base either — starts the read again. The tab never fell back to the
   * diff because the "is the base settled?" test was never true for one tick.
   */
  const editTried = useRef<Set<string>>(new Set());
  const editStaged = useRef<Set<string>>(new Set());
  /** A disk read can land after the last stream tick; nothing else would re-run
   * this effect to use it. The counter has to be a DEPENDENCY, not just a
   * re-render: without it the pre-edit text arrives and the pass that would show
   * it never runs again, so the tab sits empty until the next stream tick. */
  const [baseTick, rerun] = useReducer((n: number) => n + 1, 0);

  // The monitor's session (which app, whether it is live) settles after the
  // call that started it; the pass that names the tab after it has to run again.
  useEffect(() => macMonitorFeed.subscribe(rerun), []);
  // So does the bridge adopting a browser tab for the model.
  useEffect(() => subscribeDrivenBrowserTab(rerun), []);
  /** The user turn in which the model's own browser tab was last brought
   * forward — once per turn, so a user who clicks away is not dragged back. */
  const browsingTurn = useRef(-1);

  // A session boundary wipes the slate: the latch, and every id-keyed set, which
  // referred to a thread that is no longer the one on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session change
  useEffect(() => {
    opened.current = false;
    userTurns.current = -1;
    finalized.current.clear();
    editBase.current.clear();
    editReading.current.clear();
    editTried.current.clear();
    editStaged.current.clear();
  }, [sessionEpoch]);

  /* `baseTick` is a re-run TRIGGER, not a value read in the body: an async
     pre-edit read lands after the last stream tick and nothing else would wake
     this effect to use it. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseTick re-runs the pass
  useEffect(() => {
    if (corpActive || bgStreaming) return;

    const turns = messages.reduce((n, m) => (m.kind === 'user' ? n + 1 : n), 0);
    if (turns !== userTurns.current) {
      userTurns.current = turns;
      if (controller.getState().tabs.every((t) => t.key !== ACTIVITY_TAB_KEY))
        opened.current = false;
    }

    const stream = detectActivity(messages, partials, cwd, { settled: !streaming, executing });
    const pure = activitySpec(stream, cwd);
    /*
     * THE MONITOR RIDES THE ACTIVITY TAB. The frames come from the app-wide
     * feed, and the subtitle is the app being driven once the session says
     * which — "TextEdit" reads better under "Activity" than "snapshot" does.
     */
    const session = macMonitorFeed.getSession();
    const spec =
      pure?.kind === 'computer-use'
        ? {
            ...pure,
            macMonitor: macMonitorFeed,
            ...(session.active && session.appName !== '' ? { subtitle: session.appName } : {}),
          }
        : pure;
    if (spec === undefined) {
      /*
       * NOTHING TO SHOW — and if the tab is still up, it is showing something
       * that is no longer true. SEEN: a `write` of fox-storybook.png streamed
       * into the Activity tab, was REFUSED (a picture written as text), and the
       * tab kept the refused HTML under "Pictures › fox-test › fox-storybook.png"
       * for good. The canvas report then told the model the user was looking
       * at that file, and the model told the user the picture was saved. A
       * file tab whose write is not in the record comes down; a terminal or
       * browser surface is a real thing that happened and stays.
       */
      const stale = controller.getState().tabs.find((t) => t.key === ACTIVITY_TAB_KEY);
      if (stale !== undefined && stale.kind === 'file') controller.closeTab(stale.id);
      return;
    }

    /*
     * THE PAGE THE MODEL IS DRIVING IS THE THING TO SHOW. When the bridge
     * adopted a browser tab that is NOT the Activity tab — the page the user
     * already had open — the Activity tab must not become a second, empty
     * browser beside it. Bring the driven tab forward instead, once per turn
     * (a user who clicks away is not dragged back), and leave the Activity tab
     * as it was. When the model browses in the Activity tab itself, or the
     * bridge has not adopted anything yet, the spec below keeps it a browser.
     */
    if (spec?.kind === 'browser') {
      const driven = getDrivenBrowserTab();
      const tabs = controller.getState().tabs;
      const activityId = tabs.find((t) => t.key === ACTIVITY_TAB_KEY)?.id;
      if (driven !== null && driven !== activityId && tabs.some((t) => t.id === driven)) {
        if (browsingTurn.current !== turns) {
          browsingTurn.current = turns;
          controller.focusTab(driven);
          useCanvasStore.getState().setCanvasOpen(true);
        }
        return;
      }
    }

    const present = controller.getState().tabs.some((t) => t.key === ACTIVITY_TAB_KEY);
    /*
     * A tab that is THERE counts as opened this turn, whoever put it there —
     * the per-chat canvas snapshot restores it on a chat switch without this
     * pass creating it. MEASURED (mac-monitor-chat-scope-probe, real app):
     * back in the driving chat the restored monitor was closed by the user and
     * the next feed tick re-created it, because the latch still read "never
     * opened".
     */
    if (present) opened.current = true;
    if (!present && opened.current) return; // dismissed this turn — respect it.

    const { created, id } = morphActivityTab(controller, spec);
    if (created) {
      opened.current = true;
      // The rail itself, so the surface actually renders. Only on CREATE — a
      // running command must never prise the panel back open while the user is
      // reading something else.
      useCanvasStore.getState().setCanvasOpen(true);
    }

    if (stream.focus?.kind !== 'file') return;
    const write = stream.focus.write;
    const path = write.path;

    // ── the file half: content, the edit motion, then the settled bytes ──────
    const tabNow = () => controller.getState().tabs.find((t) => t.id === id);

    if (created || tabNow()?.fileTree === undefined) {
      /*
       * The tree is rooted at the WORKING FOLDER, not the file's own directory:
       * the active project when there is one, else the session cwd, else the
       * directory the file is in. Same rule as a directly-opened file tab
       * (file-tabs' `treeRootFor`) — read here rather than in `activitySpec` so
       * that stays a pure function of the stream.
       */
      const root = useProjectStore.getState().activePath ?? cwd ?? dirname(path);
      controller.updateTab(id, { fileTreeRootLabel: basename(root) });
      void window.piDesktop
        .invoke('fs:list-tree', { root })
        .then((res) => {
          const tab = tabNow();
          if (tab?.filePath === path) controller.updateTab(tab.id, { fileTree: res.tree });
        })
        .catch(() => undefined);
      void hydrateOpenApps(controller, id, path);
    }

    if (write.edit !== undefined) {
      /*
       * AN EDIT SHOWS THE FILE, THEN PLAYS THE EDIT INTO IT (queue item 4). The
       * decision of motion-vs-diff is `presentEdit`, imported rather than
       * re-implemented, so the Activity tab and a directly-opened file tab can
       * never disagree about how an edit looks.
       */
      if (!editBase.current.has(write.callId) && !editTried.current.has(write.callId)) {
        editTried.current.add(write.callId);
        const shown = tabNow()?.streaming === true ? undefined : tabNow()?.artifact?.content.text;
        if (shown !== undefined) {
          editBase.current.set(write.callId, shown);
        } else {
          editReading.current.add(write.callId);
          void readFileSettled(path).then((read) => {
            if (readHasContent(read) && read.text !== null) {
              editBase.current.set(write.callId, read.text);
            }
            editReading.current.delete(write.callId);
            rerun();
          });
        }
      }
      const base = editBase.current.get(write.callId);
      const tab = tabNow();
      if (tab !== undefined && base !== undefined && tab.artifact === undefined) {
        controller.updateTab(tab.id, { artifact: fileArtifactFromText(path, base) });
      }
      /*
       * AN EDIT THAT IS HISTORY IS NOT REPLAYED. Once the turn is over, the
       * tab settling back onto this file wants the file — and staging the
       * diff now would land AFTER the settled read that clears it (SEEN: the
       * settle rule brought index.html back as "− Count / + Clicks" instead of
       * the page). While the model is still working, the motion plays as before.
       */
      const ready =
        write.hunks !== undefined && !editReading.current.has(write.callId) && streaming;
      if (tab !== undefined && ready && !editStaged.current.has(write.callId)) {
        editStaged.current.add(write.callId);
        const shown = presentEdit(path, base, write.hunks, write.edit);
        controller.updateTab(
          tab.id,
          shown.kind === 'animate'
            ? {
                artifact: fileArtifactFromText(path, shown.plan.baseText),
                editAnim: { id: write.callId, plan: shown.plan, startedAt: Date.now() },
                diff: undefined,
                streaming: write.running,
              }
            : { diff: shown.diff, editAnim: undefined, streaming: write.running },
        );
      }
    } else if (write.contentHint !== undefined && write.running) {
      // A whole-file write draws as it streams, from the tool's own arguments.
      const tab = tabNow();
      if (tab !== undefined && tab.artifact?.content.text !== write.contentHint) {
        controller.updateTab(tab.id, { artifact: fileArtifactFromText(path, write.contentHint) });
      }
    }

    if (!write.running && !finalized.current.has(write.callId)) {
      finalized.current.add(write.callId);
      void readFileSettled(path).then((read) => {
        const tab = tabNow();
        // The tab may have moved on to something else while the read was out.
        if (tab === undefined || tab.filePath !== path) return;
        controller.updateTab(tab.id, {
          streaming: false,
          // The written bytes must never stay masked by a mid-flight hunk. The
          // MOTION is left alone: it carries its own start clock, so it settles
          // rather than replays, and clearing it here would cut it off.
          diff: undefined,
          ...(readHasContent(read)
            ? { artifact: fileArtifact(path, read) }
            : tab.artifact === undefined
              ? {
                  artifact: unreadableFileArtifact(path, (read as ReadFileResult | null)?.reason),
                }
              : {}),
        });
      });
    }
    // (`sessionEpoch` is deliberately NOT a dependency here: the reset effect
    // above owns it, and a session boundary always hands us a new `messages`.)
  }, [
    messages,
    partials,
    executing,
    cwd,
    corpActive,
    bgStreaming,
    streaming,
    controller,
    baseTick,
  ]);
}
