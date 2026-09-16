import type { CoordinationEvent } from '@pi-desktop/coordination';
import type { DiffFileData } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { Artifact } from '../model.ts';
import type { NodeTiming } from '../situation/situation-model.ts';
import type { MacMonitorFeed } from '../surfaces/computer-use-feed.ts';
import type { EditAnimationSpec } from '../surfaces/use-edit-animation.ts';

/**
 * The kinds a canvas tab can host. Each maps to a surface component (browser |
 * terminal | subagent | situation are LIVE surfaces the app wires to native
 * content or a live stream; the rest render from an {@link Artifact}). The
 * union is closed on purpose here — the tab bar renders a per-kind type icon —
 * but a new kind is a one-line add across this union + `CANVAS_TAB_KINDS`.
 */
export type CanvasTabKind =
  | 'browser'
  // A LIVE office editor (docx / xlsx / pptx / pdf) — a native WebContentsView
  // overlay backed by the vendored GenOffice editors, hosted exactly like a
  // `browser` tab. Distinct from `doc`/`pdf`, which are the read-only
  // artifact-backed previews that remain the fallback when the vendored tree
  // has not been built.
  | 'office'
  | 'file'
  | 'filetree'
  | 'terminal'
  | 'html'
  | 'svg'
  | 'image'
  // A live GENERATION image surface (candidate grid + step progress + model
  // footnote): artifact-backed like `image`, but rendered by the gen-canvas
  // surface (registered additively) so it streams candidates as a job runs.
  | 'gen-image'
  | 'video'
  // Audio file preview (waveform-free <audio> element), routed by extension the
  // same way image/video are (MediaPreviewSurface's <audio> branch).
  | 'audio'
  // The 3D workspace surface (generate → preview → export GLB). Placeholder kind
  // for the TRELLIS 3D pillar; no surface is registered for it yet, so a `3d`
  // tab renders the "no surface" state until that workspace lands.
  | '3d'
  // A static 3D MODEL file preview (glb/gltf/obj/stl/ply) rendered by the
  // three.js ModelSurface — the preview twin of the `3d` generation workspace,
  // mirroring how `image` (preview) pairs with `gen-image` (generation).
  | 'model'
  // An Office DOCUMENT preview: Word (docx, full render via mammoth) and
  // PowerPoint (pptx, a foundation slide render). One `doc` kind; the DocSurface
  // branches on `mediaType` ('DOCX' | 'PPTX').
  | 'doc'
  | 'pdf'
  | 'subagent'
  | 'situation'
  // The Mac computer-use MONITOR: a live view of the app Pi is driving — its
  // window and any sheets/dialogs it opens, drawn at real point size over the
  // user's wallpaper with the phantom cursor on top. LIVE, but unlike
  // browser/terminal it needs no native view: the app feeds it decoded frames
  // through `macMonitor` and the surface paints them onto a <canvas>.
  | 'computer-use'
  | 'markdown'
  | 'code'
  // A data visual (ChartSurface): artifact-backed, its text the JSON spec.
  | 'chart';

/** The media-preview surface's load state (loading → loaded | error). */
export type MediaPreviewStatus = 'loading' | 'loaded' | 'error';

/**
 * One node in a {@link FileTree}. A `dir` node carries `children`; a `file` node
 * is a leaf. `path` is the full path used for breadcrumb/open/reveal targeting;
 * `name` is the display label. Pure data — no UI coupling.
 */
export interface FileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileTreeNode[];
}

/**
 * Identifier of an app in the file "Open with" list — a system app id / bundle
 * id the app resolves. Free-form: the desktop app supplies the real app list.
 * `Open in folder` is emitted separately via `onReveal` (it reveals, not opens).
 */
export type OpenWithAppId = string;

/**
 * One app in the file "Open" split button. The desktop app fetches the system
 * icon and passes it as a `data:` URL; the canvas renders whatever is given and
 * falls back to a generic app glyph when `iconDataUrl` is absent.
 */
export interface OpenWithApp {
  id: OpenWithAppId;
  name: string;
  /** `data:` URL of the app's system icon (app-supplied; optional). */
  iconDataUrl?: string;
}

/** A file tab's raw↔rendered view preference (md defaults to rendered, code to raw). */
export type FileViewMode = 'raw' | 'rendered';

/** One subagent row in the subagent surface (pure data — no UI coupling). */
export interface SubagentItem {
  id: string;
  name: string;
  /** The subagent's current step ("Reading files…"); shimmered while running. */
  step?: string;
  status?: 'queued' | 'running' | 'done' | 'error';
  /** The ordered tool/step labels the subagent ran (its activity timeline) —
   * shown when the row is clicked to "view work". */
  activity?: string[];
  /** The subagent's full final output (its summary) or error — set on completion,
   * shown in the "view work" detail. */
  output?: string;
}

/**
 * A canvas tab. `id` is controller-assigned; `key` is the app-stable upsert key
 * (an artifact id or URL) so re-opening the same artifact focuses its existing
 * tab instead of piling up duplicates. The typed optional fields carry the
 * common live-surface state; `data` is an escape hatch for anything else.
 */
export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  title: string;
  /**
   * A quieter second line under the title, for a tab whose NAME must stay put
   * while its CONTENTS change — the corp run's "Agent activity" tab, which is
   * the same tab all run long and shows whatever the followed agent is touching.
   * Renaming it per file made the tab bar shuffle under the cursor; this says
   * what is inside without moving anything.
   */
  subtitle?: string;
  /** Stable identity for `upsertTab(key, …)` — open-or-focus by this key. */
  key?: string;
  /** Override the kind's default type icon in the tab bar. */
  icon?: ReactNode;
  /** Artifact-backed surfaces (code | markdown | html | svg | image | pdf | file). */
  artifact?: Artifact;
  /**
   * When true, the file/code surface treats `artifact.content` as LIVE — it
   * reconciles appended text without resetting scroll and auto-scrolls to the
   * newest line as the file is written. Set while a write/edit is in flight.
   */
  streaming?: boolean;

  // file surface state (the per-tab operation bar reads these)
  /** Full path of the open file — drives the breadcrumb + open/reveal targeting. */
  filePath?: string;
  /** Explicit breadcrumb segments; when omitted they derive from `filePath`. */
  breadcrumb?: string[];
  /** Tree shown in the file surface's toggleable file-tree panel. */
  fileTree?: FileTreeNode[];
  /** Top-level label for the file tree (the project / working folder). */
  fileTreeRootLabel?: string;
  /** Default app for the "Open" split button (its icon shows on the Open segment). */
  defaultApp?: OpenWithApp;
  /** Apps in the "Open with" dropdown — the {@link defaultApp} is omitted from it. */
  openApps?: OpenWithApp[];
  /** Persisted raw↔rendered preference for the file view (per-tab). */
  rawRendered?: FileViewMode;
  /**
   * Live line-diff counts for a file being written NOW (a corp worker's edit) —
   * the file surface shows a small +N/−N badge fed from these. Left unset for an
   * ordinary chat file tab, which shows no badge.
   */
  addedLines?: number;
  removedLines?: number;
  /**
   * FALLBACK for an edit that cannot be animated: the hunk drawn as a diff.
   *
   * An edit normally arrives as {@link editAnim} and plays INTO the file. This
   * is what is left when there is nowhere to play it — the file could not be
   * read, or the tool's `old_string` does not occur in it. Cleared on
   * completion, when the tab settles to the on-disk file.
   */
  diff?: DiffFileData[];
  /**
   * A LIVE EDIT, as a motion rather than a diff: the replaced text
   * forward-deletes out of the file and the replacement types in behind it.
   * Set when the edit's arguments have finished arriving and the file's prior
   * text is known; carries its own start clock so a tab switched away from
   * mid-edit settles instead of replaying. Takes precedence over {@link diff}.
   */
  editAnim?: EditAnimationSpec;

  // browser surface state (app-updated via controller.updateTab)
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
  /** Show the "model is driving" indicator on the browser chrome. */
  driving?: boolean;

  // media surface state (image | pdf)
  mediaSrc?: string;
  mediaType?: string;
  mediaIndex?: number;
  mediaStatus?: MediaPreviewStatus;
  /** Formats offered in the media operation bar's "Download as …" dropdown. */
  downloadFormats?: string[];

  // subagent surface state
  subagents?: SubagentItem[];

  // situation-room surface state: the task's live CoordinationEvent stream
  // (`TaskHandle.events` from the engine bridge, or the scripted mock). The
  // surface folds it into the renderable situation state itself. Tab switches
  // unmount the surface, so give it a RE-ITERABLE stream — wrap a single-pass
  // engine handle in `replayableEvents()` so a remount replays history.
  situationEvents?: AsyncIterable<CoordinationEvent>;
  /** Task id the situation events belong to (resets the fold when it changes). */
  situationTaskId?: string;
  /** Experience level (round-12 userMode): `power` shows raw file paths +
   * line deltas in the room; `user` (default) gets the calm, path-free view. */
  situationUserMode?: 'user' | 'power';
  /** The worker whose live stream the app is showing (highlights its node). */
  situationSelectedNodeId?: string;
  /**
   * Per-node working timing (from the renderer's corp store), keyed by nodeId —
   * the surface renders each subagent's live timer + "finished in Nm Ns" from
   * it. The pure situation fold can't carry a clock, so the app pushes this in.
   */
  situationNodeTiming?: Record<string, NodeTiming>;

  /**
   * Mac computer-use monitor: the live frame source for a `computer-use` tab.
   * Imperative on purpose (see computer-use-feed.ts) — a 12fps stream must not
   * write to the tab store, so the tab carries the FEED and the surface reads
   * frames off it directly. Same shape of arrangement as `situationEvents`.
   */
  macMonitor?: MacMonitorFeed;

  /**
   * This tab was LIFTED from an inline card in the chat — a chart or a small
   * SVG that started beside the words and was moved over. The operation bar
   * offers "Show in chat", which closes the tab; the card comes back where it
   * was (the tab's key is the card's, so the two are never both shown).
   */
  inline?: boolean;

  /** Free-form per-surface data the core never reads. */
  data?: Record<string, unknown>;
}

/** What `openTab`/`upsertTab` accept — a tab without its controller-assigned id. */
export type CanvasTabSpec = Omit<CanvasTab, 'id'> & { id?: string };

/** The whole reducer-owned canvas state (pure, serializable, testable). */
export interface CanvasState {
  /** Ordered left→right as shown in the tab bar. */
  tabs: CanvasTab[];
  /** The focused tab, or `null` when there are no tabs. */
  activeTabId: string | null;
  /** Canvas minimized (the app hides the panel; the tab set is preserved). */
  collapsed: boolean;
  /** Canvas expanded to fill the window. */
  fullscreen: boolean;
}

/** A fresh, empty canvas. */
export const emptyCanvasState: CanvasState = {
  tabs: [],
  activeTabId: null,
  collapsed: false,
  fullscreen: false,
};
