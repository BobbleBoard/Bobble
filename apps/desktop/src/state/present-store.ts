import type { OpenWithChoice } from '@pi-desktop/ui';
/**
 * What the model has presented this conversation, and how it reaches the canvas.
 *
 * `present` is the top-level model's last act: main raises `present:show`, this
 * records the artefact so the thread can render its card, and opens the right
 * canvas surface so the thing is actually THERE beside the conversation — a page
 * rendered, an image shown, a project's tree open.
 *
 * The canvas kind is chosen from the path here rather than in the tool, because
 * the tool must stay electron-free and the canvas surfaces live on this side.
 */

import type { CanvasController, CanvasTab, CanvasTabKind } from '@pi-desktop/canvas';
import { type ChartSpec, normalizeChartSpec } from '@pi-desktop/charts';
import type { PresentKind } from '@pi-desktop/ui';
import { create } from 'zustand';
import { type DiagramCardPayload, readDiagramCard } from '../../electron/pi/diagram-card';
import { htmlWidget } from '../../electron/pi/html-widget';
import { previewKindForExt } from '../chat/canvas/file-preview';
import { fileTabKey, openFileInCanvas } from '../chat/canvas/file-tabs';
import { svgCardPayload } from '../chat/svg-size';
import { getCanvasController, useCanvasStore } from './canvas-store';
import { usePiStore } from './pi-slice';

export interface PresentedRecord {
  path: string;
  note?: string;
  kind: PresentKind;
  /** Monotonic, so a re-present of the same path moves it to the end. */
  at: number;
  /**
   * The message this artefact was handed over AFTER, so the card can sit where
   * it was made instead of at the foot of the conversation.
   *
   * the user: "file presentation cards seem pinned to the bottom of the chat for
   * some time instead of staying at the position they were created at." They
   * were rendered as one block after the last message, so every card any turn
   * had ever produced slid down under whatever you said next — three questions
   * later, the picture from the first answer was still hovering above the
   * composer. Null when nothing had been said yet (they lead the thread then,
   * which is where they were made).
   */
  afterMessageId: string | null;
  /** Apps that can open it — hydrated after the record appears. */
  openApps?: readonly OpenWithChoice[];
  defaultApp?: OpenWithChoice;
  /**
   * A chart's spec, when the presented .svg had the `chart` tool's sidecar
   * beside it: the thread renders the interactive card from this instead of a
   * file row, and the canvas only on request. the user: "some items showing inline
   * cards like anthropic has here, while larger things go to the canvas still".
   */
  chart?: ChartSpec;
  /**
   * A diagram's card, when the presented .svg is the `diagram` tool's: both
   * drawings (the thread shows the one for its theme) and the Mermaid behind
   * them. The diagram shows IN the thread, like a chart (VQ-10).
   */
  diagram?: DiagramCardPayload;
  /**
   * A presented SVG's size and, when it is icon-sized and light, its markup —
   * the drawing itself goes inline; a poster stays a canvas tab.
   */
  svg?: { width: number; height: number; bytes: number; text?: string };
  /** An interactive widget's page (present-inline.ts `htmlWidget`): the thread runs it. */
  html?: { text: string; title?: string };
  /**
   * When it was handed over, in THIS run of the app (wall clock) — absent for
   * a card brought back from a transcript. A card that has only just arrived
   * builds itself in (a drawing draws, a diagram moves from its last version);
   * one scrolled back to, or rehydrated after a restart, is simply there.
   */
  shownAt?: number;
}

/**
 * The card this one is a new version of: the same file, handed over earlier
 * in the same chat (a diagram_edit a turn later, a chart redrawn in place) —
 * what a new version moves on from as it arrives.
 */
export function earlierVersion(
  state: { byChat: Record<string, PresentedRecord[]> },
  item: PresentedRecord,
): PresentedRecord | undefined {
  const chat = Object.values(state.byChat).find((list) => list.includes(item));
  if (chat === undefined) return undefined;
  let best: PresentedRecord | undefined;
  for (const r of chat) {
    if (r === item || r.path !== item.path || r.at >= item.at) continue;
    if (best === undefined || r.at > best.at) best = r;
  }
  return best;
}

/** Does this record show the thing itself in the thread (a chart or diagram card, a small SVG)? */
export function isInlinePresented(
  item: Pick<PresentedRecord, 'chart' | 'diagram' | 'svg' | 'html'>,
): boolean {
  return (
    item.chart !== undefined ||
    item.diagram !== undefined ||
    item.svg?.text !== undefined ||
    item.html !== undefined
  );
}

/** The canvas tab key a presented path opens under — the inline card's twin. */
export function presentTabKey(path: string): string {
  return `present:${path}`;
}

/** Extension → how we label it and which canvas surface opens it. */
const BY_EXT: Record<string, { kind: PresentKind; tab: CanvasTabKind }> = {
  png: { kind: 'image', tab: 'image' },
  jpg: { kind: 'image', tab: 'image' },
  jpeg: { kind: 'image', tab: 'image' },
  gif: { kind: 'image', tab: 'image' },
  webp: { kind: 'image', tab: 'image' },
  svg: { kind: 'image', tab: 'svg' },
  html: { kind: 'page', tab: 'html' },
  htm: { kind: 'page', tab: 'html' },
  mp4: { kind: 'media', tab: 'video' },
  mov: { kind: 'media', tab: 'video' },
  webm: { kind: 'media', tab: 'video' },
  md: { kind: 'document', tab: 'file' },
  txt: { kind: 'document', tab: 'file' },
  pdf: { kind: 'document', tab: 'file' },
  py: { kind: 'code', tab: 'file' },
  ts: { kind: 'code', tab: 'file' },
  js: { kind: 'code', tab: 'file' },
  gd: { kind: 'code', tab: 'file' },
  json: { kind: 'code', tab: 'file' },
};

/** Lowercase extension without the dot, or '' when there is none. */
export function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a presented path.
 *
 * A path with no extension is treated as a PROJECT and opened as a file tree —
 * that is the case the Godot run got wrong (14 files, none opened), and a tree
 * is the surface that makes "does this actually contain a game?" answerable at a
 * glance.
 */
export function classifyPresented(p: string): { kind: PresentKind; tab: CanvasTabKind } {
  const ext = extOf(p);
  if (ext === '') return { kind: 'project', tab: 'filetree' };
  return BY_EXT[ext] ?? { kind: 'file', tab: 'file' };
}

/** The bucket for a chat that has no session file yet. */
export const UNSAVED_CHAT = '';

interface PresentState {
  /**
   * Presented artefacts PER CHAT, keyed by session file. One flat list used to
   * serve every chat: a card handed over in one conversation had no anchor in
   * any other, so it fell to the foot of whichever chat was being viewed —
   * "pinned to the bottom of a chat" (the user, 2026-09-12), in chats that had
   * never seen the file.
   */
  byChat: Record<string, PresentedRecord[]>;
  add: (item: {
    path: string;
    note?: string;
    afterMessageId?: string | null;
    /** The chat the hand-over belongs to (its session file); unsaved → ''. */
    chat?: string;
    /** The chart spec beside a presented .svg, as main read it (unvalidated). */
    chart?: Record<string, unknown>;
    diagram?: DiagramCardPayload;
    svg?: { width: number; height: number; bytes: number; text?: string };
    html?: { text: string; title?: string };
    /** Handed over just now, in this run (see PresentedRecord.shownAt). */
    shownAt?: number;
  }) => PresentedRecord;
  /** Attach the apps that can open a presented artefact (async, best-effort). */
  setApps: (path: string, apps: OpenWithChoice[], defaultAppId: string | null) => void;
  /**
   * The chat that had no session file has one now: its cards move under it.
   * The first turn of a new chat presents into the '' bucket; the moment pi
   * names the session the thread reads a different key and every card of that
   * turn vanished (SEEN, the user 2026-09-17: "I just went back to a chat I
   * earlier made some visuals in and it didn't have them there").
   */
  claimUnsaved: (chat: string) => void;
  /**
   * The same conversation, continued in another session file. Taking back a
   * message rewinds pi onto a branch of the chat (`pi:fork` writes a new file),
   * and the thread then reads its cards under the new key — where there were
   * none, so every card the chat had shown vanished with the one message. The
   * cards belong to the conversation: those still anchored in it (`keep`) are
   * copied across; one already there (rehydrated from the transcript) is not
   * doubled.
   */
  carry: (from: string, to: string, keep: (afterMessageId: string | null) => boolean) => void;
  clear: () => void;
}

const NONE: PresentedRecord[] = [];

/** The cards of one chat — a stable empty list when it has none. */
export function presentedFor(state: PresentState, chat: string): PresentedRecord[] {
  return state.byChat[chat] ?? NONE;
}

export const usePresentStore = create<PresentState>((set, get) => ({
  byChat: {},
  add: ({
    path,
    note,
    afterMessageId = null,
    chat = UNSAVED_CHAT,
    chart,
    diagram,
    svg,
    html,
    shownAt,
  }) => {
    const { kind } = classifyPresented(path);
    const have = presentedFor(get(), chat);
    // A spec main could read but the chart model cannot make sense of is a
    // plain file again — the card must never throw for a sidecar's typo.
    let spec: ChartSpec | undefined;
    if (chart !== undefined) {
      try {
        spec = normalizeChartSpec(chart);
      } catch {
        spec = undefined;
      }
    }
    const record: PresentedRecord = {
      path,
      kind: spec !== undefined ? 'chart' : kind,
      at: have.reduce((m, i) => Math.max(m, i.at), 0) + 1,
      afterMessageId,
      ...(note !== undefined ? { note } : {}),
      ...(spec !== undefined ? { chart: spec } : {}),
      ...(spec === undefined && diagram !== undefined ? { diagram } : {}),
      ...(svg !== undefined ? { svg } : {}),
      ...(html !== undefined ? { html } : {}),
      ...(shownAt !== undefined ? { shownAt } : {}),
    };
    /*
     * A file presented again from the SAME message (the model iterating within
     * one turn) replaces its card. Presented again from a later message it is a
     * NEW card, and the earlier one stays where it was made — the user: "if the
     * model presents the same file and it has an update that's when a new file
     * card appears below but they don't travel through a user sent message."
     */
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chat]: [
          ...presentedFor(s, chat).filter(
            (i) => !(i.path === path && i.afterMessageId === afterMessageId),
          ),
          record,
        ],
      },
    }));
    /*
     * Ask the OS which applications can open this, the same way the canvas
     * operation bar does — so the card's Open control offers the same choices
     * rather than a lookalike with an empty menu (the user: "the same thing as the
     * 'open' button inside the canvas... with the little dropdown also").
     * Best-effort and async: the button works from the moment it renders,
     * opening with the OS default, and the caret appears if alternatives exist.
     */
    /* `?.` on the bridge alone is not enough: it yields undefined, and calling
     * `.then` on that throws. Unit tests run without a preload bridge. */
    const bridge = typeof window === 'undefined' ? undefined : window.piDesktop;
    if (bridge !== undefined) {
      void bridge
        .invoke('canvas:list-open-apps', { path })
        .then((res) => {
          const r = res as { apps?: OpenWithChoice[]; defaultAppId?: string | null };
          get().setApps(path, r.apps ?? [], r.defaultAppId ?? null);
        })
        .catch(() => {
          // No app list — Open still works via the OS default.
        });
    }
    return record;
  },
  setApps: (path, apps, defaultAppId) =>
    set((s) => ({
      byChat: Object.fromEntries(
        Object.entries(s.byChat).map(([chat, items]) => [
          chat,
          items.map((i) =>
            i.path === path
              ? {
                  ...i,
                  openApps: apps,
                  ...(defaultAppId !== null
                    ? { defaultApp: apps.find((a) => a.id === defaultAppId) }
                    : {}),
                }
              : i,
          ),
        ]),
      ),
    })),
  claimUnsaved: (chat) =>
    set((s) => {
      const unsaved = s.byChat[UNSAVED_CHAT];
      if (chat === UNSAVED_CHAT || unsaved === undefined || unsaved.length === 0) return {};
      const { [UNSAVED_CHAT]: _moved, ...rest } = s.byChat;
      return { byChat: { ...rest, [chat]: [...(rest[chat] ?? []), ...unsaved] } };
    }),
  carry: (from, to, keep) =>
    set((s) => {
      if (from === to) return {};
      const have = s.byChat[to] ?? [];
      const add = (s.byChat[from] ?? []).filter(
        (r) =>
          keep(r.afterMessageId) &&
          !have.some((h) => h.path === r.path && h.afterMessageId === r.afterMessageId),
      );
      if (add.length === 0) return {};
      return { byChat: { ...s.byChat, [to]: [...have, ...add] } };
    }),
  clear: () => set({ byChat: {} }),
}));

/* ── the cards come back with the chat ─────────────────────────────────── */

/** The chart files a thread's tool results name, with the message each was made in. */
export function chartsInTranscript(
  messages: ReadonlyArray<{
    kind: string;
    id: string;
    blocks?: ReadonlyArray<{
      type: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
    toolCallId?: string;
    toolName?: string;
    text?: string;
    isError?: boolean;
  }>,
  /** The chat's working folder — what a relative path in a reply is relative to. */
  root?: string,
): Array<{ path: string; afterMessageId: string }> {
  const out: Array<{ path: string; afterMessageId: string }> = [];
  const owner = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks ?? []) {
      if (b.type === 'toolCall' && b.id !== undefined) owner.set(b.id, m.id);
    }
  }
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.kind !== 'toolResult' || m.isError === true || m.toolCallId === undefined) continue;
    const anchor = owner.get(m.toolCallId);
    if (anchor === undefined) continue;
    // "Drew a bar chart …: /abs/units.svg (the spec beside it: …)" and
    // "Changed … → a bar chart …: /abs/units.svg." — the chart tool's own
    // reply, native or through bash — and "Presented /abs/x.svg to the user".
    // Relative to the working folder since 2026-09-17 ("Drew …: units.svg");
    // the caller resolves against the root it knows.
    const text = m.text ?? '';
    const match =
      /^(?:Drew|Changed)\b[^\n]*?:\s+(\S+\.svg)\b/.exec(text) ??
      /^Presented (\S+\.svg) to the user/.exec(text) ??
      // A presented page: its card is the widget, when it is one (html-widget.ts).
      /^Presented (\S+\.html?) to the user/i.exec(text) ??
      // The svg tool's own reply: "Made 1 SVG:\n  1. /abs/01.svg — 30 paths".
      /^Made \d+ SVGs?[^\n]*\n\s*1\.\s+(\S+\.svg)\s+—/.exec(text);
    const said = match?.[1];
    if (said === undefined) continue;
    const path =
      said.startsWith('/') || root === undefined ? said : `${root.replace(/\/+$/, '')}/${said}`;
    const key = `${path}@${anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, afterMessageId: anchor });
  }
  return out;
}

/**
 * REBUILD A CHAT'S CARDS FROM ITS TRANSCRIPT. The store is memory; a chat
 * reopened after the app restarted had none of the charts it made (the user,
 * 2026-09-17). The transcript names every chart file the tool wrote, and the
 * spec beside each (<stem>.chart.json) is what the card draws — so a chat that
 * is opened with no cards recorded reads them back off disk.
 */
export async function rehydratePresented(
  chat: string,
  messages: Parameters<typeof chartsInTranscript>[0],
  root?: string,
): Promise<number> {
  const bridge = typeof window === 'undefined' ? undefined : window.piDesktop;
  if (bridge === undefined) return 0;
  let added = 0;
  for (const { path, afterMessageId } of chartsInTranscript(messages, root)) {
    if (/\.html?$/i.test(path)) {
      let html: { text: string; title?: string } | null = null;
      try {
        const read = (await bridge.invoke('fs:read-file', { path })) as { text?: string | null };
        html = typeof read?.text === 'string' ? htmlWidget(read.text) : null;
      } catch {
        html = null;
      }
      if (html === null) continue;
      const have = presentedFor(usePresentStore.getState(), chat);
      if (have.some((r) => r.path === path && r.afterMessageId === afterMessageId)) continue;
      usePresentStore.getState().add({ path, chat, afterMessageId, html });
      added += 1;
      continue;
    }
    const sidecar = `${path.slice(0, -4)}.chart.json`;
    let chart: Record<string, unknown> | undefined;
    try {
      const read = (await bridge.invoke('fs:read-file', { path: sidecar })) as { text?: string };
      if (typeof read?.text === 'string' && read.text.trim() !== '') {
        chart = JSON.parse(read.text) as Record<string, unknown>;
      }
    } catch {
      chart = undefined;
    }
    /*
     * NO CHART SIDECAR: a diagram (the diagram tool's own sidecar beside it —
     * both drawings back, the same reader main uses on the way in), or a
     * plain drawing (the svg tool's, a presented icon), whose card is its
     * markup when it is small enough to sit in the thread.
     */
    let svg: { width: number; height: number; bytes: number; text?: string } | undefined;
    let diagram: DiagramCardPayload | undefined;
    if (chart === undefined) {
      const readText = async (p: string): Promise<string> => {
        const read = (await bridge.invoke('fs:read-file', { path: p })) as { text?: string | null };
        if (typeof read?.text !== 'string') throw new Error(`cannot read ${p}`);
        return read.text;
      };
      let markup = '';
      try {
        markup = await readText(path);
      } catch {
        markup = '';
      }
      diagram =
        markup === '' ? undefined : ((await readDiagramCard(path, markup, readText)) ?? undefined);
      svg = markup === '' || diagram !== undefined ? undefined : svgCardPayload(markup);
      if (diagram === undefined && svg?.text === undefined) continue;
    }
    // The chat may have been opened elsewhere while the sidecars were read.
    const have = presentedFor(usePresentStore.getState(), chat);
    if (have.some((r) => r.path === path && r.afterMessageId === afterMessageId)) continue;
    usePresentStore.getState().add({
      path,
      chat,
      afterMessageId,
      ...(chart === undefined ? {} : { chart }),
      ...(diagram === undefined ? {} : { diagram }),
      ...(svg === undefined ? {} : { svg }),
    });
    added += 1;
  }
  return added;
}

/**
 * Wire `present:show` → record it, and OPEN it in the canvas.
 *
 * Opening is the half that makes the card mean something: the user asked for the
 * artefact "open or running in canvas, if it's a godot game or whatever". The
 * tab is upserted by path, so the model iterating on one file re-uses its tab
 * rather than stacking a new one each pass.
 *
 * Returns the unsubscribe.
 */
/** Open (or focus) a presented artefact's canvas tab. Shared by the event
 * wiring and the card's Open button, so both land on the same tab. */
export async function openPresented(
  controller: { upsertTab: (key: string, spec: never) => string } | null,
  item: {
    path: string;
    note?: string;
    chart?: ChartSpec;
    diagram?: DiagramCardPayload;
    svg?: PresentedRecord['svg'];
  },
): Promise<void> {
  if (controller === null) return;
  const { tab } = classifyPresented(item.path);
  const title = item.path.split(/[\\/]/).pop() ?? item.path;
  /*
   * A CHART OPENS AS ITS CARD, LARGER — and SYNCHRONOUSLY, because the click
   * that opens it runs inside a view transition (flushSync): the inline card
   * has to become the tab within the same DOM update for the browser to
   * animate one into the other. The spec is already on the record, so no file
   * is read. `inline: true` puts "Show in chat" in the tab's bar; the key is
   * the card's, so the card collapses to its stub while the tab is open.
   */
  if (item.chart !== undefined) {
    const key = presentTabKey(item.path);
    controller.upsertTab(key, {
      kind: 'chart',
      key,
      title: item.chart.title !== '' ? item.chart.title : title,
      filePath: item.path,
      inline: true,
      artifact: {
        id: key,
        title: item.chart.title !== '' ? item.chart.title : title,
        filename: title,
        content: { kind: 'chart', text: JSON.stringify(item.chart) },
      },
      // No subtitle: the tool's note repeats the title ("a bar chart 'Units…'").
    } as never);
    return;
  }
  /*
   * A DIAGRAM OPENS AS ITS DRAWING, full size — the canvas is where a wide one
   * is read — and synchronously, inside the card's view transition, like a
   * chart. The drawing for the app's theme at the moment it opens.
   */
  if (item.diagram !== undefined) {
    const key = presentTabKey(item.path);
    const dark =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-mode') === 'dark';
    const drawing = dark ? item.diagram.dark : item.diagram.light;
    const name = item.diagram.title !== '' ? item.diagram.title : title;
    controller.upsertTab(key, {
      kind: 'svg',
      key,
      title: name,
      filePath: item.path,
      inline: true,
      artifact: {
        id: key,
        title: name,
        filename: title,
        content: { kind: 'svg', text: drawing.svg },
      },
    } as never);
    return;
  }
  /* A small SVG's markup travelled with the record: the same synchronous open. */
  if (item.svg?.text !== undefined) {
    const key = presentTabKey(item.path);
    controller.upsertTab(key, {
      kind: 'svg',
      key,
      title,
      filePath: item.path,
      inline: true,
      artifact: { id: key, title, filename: title, content: { kind: 'svg', text: item.svg.text } },
      ...(item.note !== undefined ? { subtitle: item.note } : {}),
    } as never);
    return;
  }
  /*
   * A DECK OPENS AS A DECK. This used to read every presented file as TEXT and
   * put it in a file tab — so a .pptx the model had just made arrived in the
   * canvas as two pages of zip bytes, and a FLAC as garbage (SEEN, in the
   * canvas assessment and in the office run). The `+ › Files` menu already
   * knows which surface a file wants — the office editor, the audio/video/3D
   * players, the PDF viewer — so a presented file goes through the same door.
   * Text and pages keep the path below: the html tab renders, the file tab
   * shows the note.
   */
  /*
   * …AND A PICTURE OPENS AS A PICTURE. The door above was only taken for a
   * `file`-tab kind, so a presented PNG — the commonest hand-over there is —
   * fell through to the text path below: `fs:read-file` on a binary, an
   * image tab with no `mediaSrc`, and the surface's "Failed to load file
   * content" beside a card that said the picture was ready. MEASURED
   * 2026-09-15 (tool-surface probe pass 3, then present-canvas-probe): the
   * thread showed the cow, the canvas tab could not. Every kind the preview
   * surfaces stream over pd-file:// goes through openFileInCanvas; only the
   * text-shaped kinds (a page, an SVG's markup) are read as text.
   *
   * …AND A TEXT FILE OPENS AS THE FILE. A presented .md / .py / .json took the
   * text path below into a tab that carried the file's TEXT and not its PATH,
   * so the bar's Open, every app in its ▾ and "Open in folder" had no file to
   * act on and did nothing at all — the user: "open buttons in the canvas … don't
   * work". SEEN 2026-09-23 (open-buttons-probe): the ▾ offered "Open in folder"
   * alone, and clicking it did nothing. openFileInCanvas is the door every other
   * file tab comes through — the path, the breadcrumb, the tree, the apps.
   */
  if (previewKindForExt(extOf(item.path)) !== null || tab === 'file') {
    const ctl = controller as unknown as CanvasController;
    const byKey = (): CanvasTab | undefined =>
      ctl.getState().tabs.find((t) => t.key === fileTabKey(item.path));
    const already = byKey();
    await openFileInCanvas(ctl, item.path);
    /* The tab just opened, by its key first: the Activity tab is usually showing
     * this very file (the model has just written it), comes earlier in the
     * strip, and owns its own subtitle — a path match alone found IT. */
    const opened = byKey() ?? ctl.getState().tabs.find((t) => t.filePath === item.path);
    if (opened !== undefined && item.note !== undefined) {
      ctl.updateTab(opened.id, { subtitle: item.note });
    }
    /*
     * Re-presenting an OPEN document means "look at it now": the editor's
     * file watcher has normally swapped the new bytes in already, but a
     * present that lands inside the watcher's debounce, or while the editor
     * itself had focus, would otherwise show the deck as it was. Forced, so
     * the tab and the file agree the moment the card appears.
     */
    if (already !== undefined && opened !== undefined && opened.kind === 'office') {
      void window.piDesktop
        .invoke('office:reload', { tabId: opened.id, force: true })
        .catch(() => undefined);
    }
    return;
  }
  /*
   * A CANVAS ARTIFACT IS `content: { kind, text }` — the file's TEXT, not a path.
   *
   * This used to pass `artifact: { kind, path, title }`, so every surface that
   * reads `artifact.content.text` threw on `undefined`. React has no error
   * boundary above the thread, so the throw unmounted the entire tree: calling
   * `present` BLANKED THE WHOLE APP. the user saw it happen — "complete blankscreen
   * after asked for the present tool to be called, I briefly saw the actual UI".
   *
   * It also explains a run of readings I could not make sense of: a document with
   * twelve nodes and no sidebar, blank screenshots, and yet a live, correctly
   * populated present store — React was gone while the module singletons and the
   * window handle survived.
   */
  let text = '';
  try {
    const read = await window.piDesktop.invoke('fs:read-file', { path: item.path });
    text = typeof read?.text === 'string' ? read.text : '';
  } catch {
    // An unreadable file still opens a tab — an empty surface the user can see
    // beats no tab and no explanation.
  }
  controller.upsertTab(`present:${item.path}`, {
    kind: tab,
    title,
    key: `present:${item.path}`,
    artifact: {
      id: `present:${item.path}`,
      title,
      filename: title,
      content: { kind: artifactKindFor(tab), text },
    },
    ...(item.note !== undefined ? { subtitle: item.note } : {}),
  } as never);
}

/**
 * The card's Open, and a click on the card itself: the artefact in the canvas
 * AND the canvas on screen.
 *
 * openPresented alone focused the tab and left a closed canvas closed. The rail
 * opens itself only when the tab COUNT grows, so an artefact whose tab already
 * existed — which is every artefact the model has presented, since presenting
 * opens it — was focused inside a drawer nobody could see, and the blue Open
 * did nothing visible (SEEN 2026-09-23, open-buttons-probe: canvas closed before
 * and after the click). The Activity rows learned the same lesson (ThreadActivity
 * onOpenCanvas); the inline chart card already opens the rail itself.
 */
export function showPresented(
  controller: Parameters<typeof openPresented>[0],
  item: Parameters<typeof openPresented>[1],
): Promise<void> {
  if (controller !== null) useCanvasStore.getState().setCanvasOpen(true);
  return openPresented(controller, item);
}

export function connectPresent(): () => void {
  /*
   * E2E handle, deliberately installed HERE rather than at module scope (same
   * opt-in as `__pi_store`). Its presence proves this wiring ran: presenting a
   * file showed no card and opened no canvas tab, and every link in the chain
   * read as correct — main logged the send, the channel is in the IPC contract,
   * ChatApp calls this, and the card renders unconditionally on a non-empty
   * store. Reading the store from a probe is the only way to tell "the event
   * never arrived" from "it arrived and nothing rendered".
   */
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    (window as unknown as { __present_store?: unknown }).__present_store = () => usePresentStore;
  }
  /*
   * THE CARDS FOLLOW THE CHAT. Two things the event above cannot cover:
   *  - a chat that gets its session file mid-conversation (the first turn of a
   *    new chat) keeps the cards it made while it had none — claimUnsaved;
   *  - a chat opened with no cards recorded (the app restarted; the store is
   *    memory) gets them back from its transcript — rehydratePresented.
   * Both key off the pi store: the session file, and the epoch that bumps on
   * every session boundary (new chat, switch, rehydrate).
   */
  let lastFile = usePiStore.getState().session?.sessionFile ?? UNSAVED_CHAT;
  let lastEpoch = usePiStore.getState().sessionEpoch;
  const rehydrated = new Set<string>();
  const unsubStore = usePiStore.subscribe((state) => {
    const file = state.session?.sessionFile ?? UNSAVED_CHAT;
    const epoch = state.sessionEpoch;
    if (file !== lastFile) {
      if (epoch === lastEpoch && lastFile === UNSAVED_CHAT && file !== UNSAVED_CHAT) {
        usePresentStore.getState().claimUnsaved(file);
      }
      lastFile = file;
    }
    lastEpoch = epoch;
    if (
      file !== UNSAVED_CHAT &&
      !rehydrated.has(file) &&
      state.messages.length > 0 &&
      state.agent.isStreaming !== true &&
      presentedFor(usePresentStore.getState(), file).length === 0
    ) {
      rehydrated.add(file);
      // The working folder the tools used, as the harness publishes it — a
      // reply names its chart relative to it since 2026-09-17.
      let root: string | undefined = state.session?.cwd ?? undefined;
      try {
        const raw = state.extensionStatus?.harness;
        const parsed = raw === undefined ? null : (JSON.parse(raw) as { workspaceRoot?: string });
        if (typeof parsed?.workspaceRoot === 'string' && parsed.workspaceRoot !== '') {
          root = parsed.workspaceRoot;
        }
      } catch {
        /* the status is not for us to parse strictly */
      }
      void rehydratePresented(
        file,
        state.messages as Parameters<typeof rehydratePresented>[1],
        root,
      );
    }
  });
  const unsubShow = window.piDesktop.onEvent('present:show', presentFromMain);
  return () => {
    unsubStore();
    unsubShow();
  };
}

/**
 * An artefact main is handing to the user — the `present` tool's, or a drawing
 * the svg tool just finished (gen-stream). Recorded as a card, and opened.
 */
export function presentFromMain({
  path,
  note,
  chart,
  diagram,
  svg,
  html,
}: {
  path: string;
  note?: string;
  chart?: Record<string, unknown>;
  diagram?: DiagramCardPayload;
  svg?: { width: number; height: number; bytes: number; text?: string };
  html?: { text: string; title?: string };
}): void {
  // Anchor it to the turn that produced it — see `afterMessageId` — in the
  // chat that is RUNNING: the one in the background if a turn is going there,
  // else the one on screen. Read lazily off the live store so this module
  // keeps no import on the chat.
  const pi = usePiStore.getState();
  const bg = pi.bgRun?.streaming === true ? pi.bgRun : null;
  const messages = bg !== null ? bg.messages : pi.messages;
  const chat = bg !== null ? bg.sessionFile : (pi.session?.sessionFile ?? UNSAVED_CHAT);
  const anchor = messages[messages.length - 1]?.id ?? null;
  const record = usePresentStore.getState().add({
    path,
    chat,
    afterMessageId: anchor,
    ...(note !== undefined ? { note } : {}),
    ...(chart !== undefined ? { chart } : {}),
    ...(diagram !== undefined ? { diagram } : {}),
    ...(svg !== undefined ? { svg } : {}),
    ...(html !== undefined ? { html } : {}),
    shownAt: Date.now(),
  });
  // The canvas belongs to the chat on screen; a background chat's artefact
  // waits in its card until the user comes back to it. A chart or a small
  // SVG shows IN the thread and does not open the canvas on its own — the
  // card's corner control moves it over when the user wants it larger.
  if (bg === null && !isInlinePresented(record)) {
    void openPresented(getCanvasController() as never, record);
  }
}

/** Canvas tab kind → the artifact kind its surface expects. */
function artifactKindFor(tab: CanvasTabKind): string {
  switch (tab) {
    case 'image':
      return 'image';
    case 'svg':
      return 'svg';
    case 'html':
      return 'html';
    case 'filetree':
      return 'file';
    default:
      return 'file';
  }
}
