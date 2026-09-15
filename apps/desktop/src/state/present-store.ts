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

import type { CanvasController, CanvasTabKind } from '@pi-desktop/canvas';
import type { PresentKind } from '@pi-desktop/ui';
import { create } from 'zustand';
import { previewKindForExt } from '../chat/canvas/file-preview';
import { fileTabKey, openFileInCanvas } from '../chat/canvas/file-tabs';
import { getCanvasController } from './canvas-store';
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
  }) => PresentedRecord;
  /** Attach the apps that can open a presented artefact (async, best-effort). */
  setApps: (path: string, apps: OpenWithChoice[], defaultAppId: string | null) => void;
  clear: () => void;
}

const NONE: PresentedRecord[] = [];

/** The cards of one chat — a stable empty list when it has none. */
export function presentedFor(state: PresentState, chat: string): PresentedRecord[] {
  return state.byChat[chat] ?? NONE;
}

export const usePresentStore = create<PresentState>((set, get) => ({
  byChat: {},
  add: ({ path, note, afterMessageId = null, chat = UNSAVED_CHAT }) => {
    const { kind } = classifyPresented(path);
    const have = presentedFor(get(), chat);
    const record: PresentedRecord = {
      path,
      kind,
      at: have.reduce((m, i) => Math.max(m, i.at), 0) + 1,
      afterMessageId,
      ...(note !== undefined ? { note } : {}),
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
  clear: () => set({ byChat: {} }),
}));

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
  item: { path: string; note?: string },
): Promise<void> {
  if (controller === null) return;
  const { tab } = classifyPresented(item.path);
  const title = item.path.split(/[\\/]/).pop() ?? item.path;
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
   * text-shaped kinds (a page, code, an SVG's markup) are read as text.
   */
  if (previewKindForExt(extOf(item.path)) !== null) {
    await openFileInCanvas(controller as unknown as CanvasController, item.path);
    const opened = (controller as unknown as CanvasController)
      .getState()
      .tabs.find((t) => t.filePath === item.path || t.key === fileTabKey(item.path));
    if (opened !== undefined && item.note !== undefined) {
      (controller as unknown as CanvasController).updateTab(opened.id, { subtitle: item.note });
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
  return window.piDesktop.onEvent('present:show', ({ path, note }) => {
    // Anchor it to the turn that produced it — see `afterMessageId` — in the
    // chat that is RUNNING: the one in the background if a turn is going there,
    // else the one on screen. Read lazily off the live store so this module
    // keeps no import on the chat.
    const pi = usePiStore.getState();
    const bg = pi.bgRun?.streaming === true ? pi.bgRun : null;
    const messages = bg !== null ? bg.messages : pi.messages;
    const chat = bg !== null ? bg.sessionFile : (pi.session?.sessionFile ?? UNSAVED_CHAT);
    const anchor = messages[messages.length - 1]?.id ?? null;
    const record = usePresentStore
      .getState()
      .add({ path, chat, afterMessageId: anchor, ...(note !== undefined ? { note } : {}) });
    // The canvas belongs to the chat on screen; a background chat's artefact
    // waits in its card until the user comes back to it.
    if (bg === null) void openPresented(getCanvasController() as never, record);
  });
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
