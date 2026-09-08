/**
 * @pi-desktop/canvas — the universal canvas surface registry + built-in
 * renderers (code | markdown | html | svg), plus the `pd-preview://` sandboxed
 * HTML harness contract. Electron-free: the harness is a static asset + a
 * postMessage protocol; the app registers the protocol and mounts <Canvas>.
 *
 * Load `@pi-desktop/canvas/styles.css` once at the root (after themes + ui).
 */

export type { CanvasPlacement, CanvasProps } from './canvas.tsx';
// Panel integration
export { Canvas } from './canvas.tsx';
export type { CanvasConfig } from './context.ts';
export { CanvasConfigContext, defaultCanvasConfig } from './context.ts';
export { artifactFilename, artifactMimeType, downloadArtifact } from './export-artifact.ts';
export type { StartHarnessOptions } from './harness/harness-runtime.ts';
export { startHarness } from './harness/harness-runtime.ts';
export type { ApplyHtmlPatchOptions } from './harness/patcher.ts';
export { applyHtmlPatch } from './harness/patcher.ts';
export type {
  AppliedMessage,
  ErrorMessage,
  FrameToHostMessage,
  HostToFrameMessage,
  PatchMessage,
  PingMessage,
  ReadyMessage,
  ResetMessage,
  ResizeMessage,
} from './harness/protocol.ts';
// pd-preview:// harness contract
export {
  isFrameToHostMessage,
  isHostToFrameMessage,
  PD_CANVAS_CHANNEL,
  PD_PREVIEW_HARNESS_HOST,
  PD_PREVIEW_HARNESS_PATH,
  PD_PREVIEW_HARNESS_URL,
  PD_PREVIEW_SCHEME,
} from './harness/protocol.ts';
// Inline vs canvas (THEME 2)
export type { InlineWidgetProps, ShouldGoToCanvasOptions } from './inline-widget.tsx';
export { InlineWidget, shouldGoToCanvas } from './inline-widget.tsx';
// Model
export type { Artifact, ArtifactContent, ArtifactKind, KnownArtifactKind } from './model.ts';
export type { SurfaceDefinition, SurfaceProps } from './registry.ts';
// Registry
export {
  defaultSurfaceRegistry,
  matchKind,
  registerSurface,
  resolveSurface,
  SurfaceRegistry,
} from './registry.ts';
// Sanitization trust boundaries
export { sanitizeHtmlStatic, sanitizeSvg } from './sanitize.ts';
export type { ExercisePanelProps } from './situation/exercise-panel.tsx';
export { ExercisePanel } from './situation/exercise-panel.tsx';
// Situation room (spec §11) — the live view of a coordination run
export type {
  MockRunHandle,
  MockRunOptions,
  TimedCoordinationEvent,
} from './situation/mock-run.ts';
export {
  buildMockCorpRunScript,
  MOCK_TASK_ID,
  mockPeekHtml,
  mockRunDurationMs,
  startMockCorpRun,
} from './situation/mock-run.ts';
export type { DivisionProgress, SituationOrgChartProps } from './situation/org-chart-panel.tsx';
export { SituationOrgChart } from './situation/org-chart-panel.tsx';
export { replayableEvents } from './situation/replay-stream.ts';
export type {
  ActionFeedRow,
  ChecklistGroup,
  ContractProgress,
  FileTouchView,
  ModuleRegionFill,
  NodeTiming,
  SituationState,
} from './situation/situation-model.ts';
export {
  contractProgress,
  crossGroupWaits,
  fillModuleRegions,
  followTarget,
  formatClock,
  formatDuration,
  formatEta,
  groupChecklist,
  initialSituation,
  nodeElapsedMs,
  reduceSituation,
  workingCount,
} from './situation/situation-model.ts';
export type {
  SituationRoomHostProps,
  SituationRoomSurfaceProps,
  SituationUserMode,
} from './situation/situation-surface.tsx';
export {
  latestArtifact,
  SituationRoomHost,
  SituationRoomSurface,
} from './situation/situation-surface.tsx';
export type { TaskBriefingBubbleProps } from './situation/task-briefing.tsx';
export { TaskBriefingBubble } from './situation/task-briefing.tsx';
export type {
  WorkerBriefing,
  WorkerStream,
  WorkerStreamEntry,
} from './situation/worker-streams.ts';
export {
  mockWorkerStreamEndMs,
  mockWorkerStreamFor,
  mockWorkerTranscriptAt,
} from './situation/worker-streams.ts';
// Surfaces
export type { BrowserSurfaceProps } from './surfaces/browser-surface.tsx';
export { BrowserSurface } from './surfaces/browser-surface.tsx';
export { streamingUpdateSpec } from './surfaces/code-append.ts';
export type { CodeSurfaceProps } from './surfaces/code-surface.tsx';
export { CodeSurface, rawSourceContent } from './surfaces/code-surface.tsx';
// Computer-use monitor (Mac): the live view of the app Pi is driving
export type { AxShape, MonitorSource } from './surfaces/computer-use-ax.ts';
export {
  axLabelFor,
  axShapeFor,
  ellipsize,
  idleCursorDrift,
  layoutAxScene,
  pickMonitorSource,
  rectOfBbox,
  restingCursor,
  wrapText,
} from './surfaces/computer-use-ax.ts';
export type {
  MacMonitorAxElement,
  MacMonitorAxScene,
  MacMonitorAxWindow,
  MacMonitorCapabilities,
  MacMonitorCursorState,
  MacMonitorDecodedFrame,
  MacMonitorFeed,
  MacMonitorRect,
  MacMonitorSessionState,
  MacMonitorStreamState,
  MacMonitorViewMode,
  MacMonitorWindowInfo,
} from './surfaces/computer-use-feed.ts';
export { IDLE_MAC_MONITOR_SESSION } from './surfaces/computer-use-feed.ts';
export type { DrawnWindow } from './surfaces/computer-use-geometry.ts';
export {
  annotationScale,
  bubbleAnchor,
  coverCrop,
  cursorEase,
  fitWindow,
  followWindow,
  screenToCanvas,
  stagePadding,
  visibleRegion,
} from './surfaces/computer-use-geometry.ts';
export type { ComputerUseSurfaceProps } from './surfaces/computer-use-surface.tsx';
export { ComputerUseSurface } from './surfaces/computer-use-surface.tsx';
// Content-slot / rect contract (native WebContentsView / PTY mounting)
export type { ContentSlotOptions } from './surfaces/content-slot.ts';
export { useContentSlot } from './surfaces/content-slot.ts';
export type {
  AnimatedHunk,
  EditAnimationOptions,
  EditAnimationPlan,
  EditFrame,
  EditHunkInput,
  EditPhase,
} from './surfaces/edit-animation.ts';
export {
  applyHunks,
  EDIT_ANIMATION_DEFAULTS,
  firstEditOffset,
  frameAt,
  locateHunks,
  MAX_ANIMATABLE_CHARS,
  minimalReplacement,
  planEditAnimation,
  planTextTransition,
} from './surfaces/edit-animation.ts';
export type { FileSurfaceProps } from './surfaces/file-surface.tsx';
export { defaultFileViewMode, FileSurface } from './surfaces/file-surface.tsx';
export type { FrameGate, HtmlSurfaceProps } from './surfaces/html-surface.tsx';
export { HtmlSurface, HtmlSurfaceController } from './surfaces/html-surface.tsx';
export { languageExtension } from './surfaces/languages.ts';
export { MarkdownSurface } from './surfaces/markdown-surface.tsx';
export type {
  MediaPreviewEvent,
  MediaPreviewStatus,
  MediaPreviewSurfaceProps,
} from './surfaces/media-preview-surface.tsx';
export {
  isVideoType,
  MediaPreviewSurface,
  mediaPreviewTransition,
} from './surfaces/media-preview-surface.tsx';
export type { OfficeSurfaceProps } from './surfaces/office-surface.tsx';
export { OfficeSurface } from './surfaces/office-surface.tsx';
export { ensureDefaultSurfaces, registerBuiltinSurfaces } from './surfaces/register-builtins.tsx';
export type { SubagentSurfaceProps } from './surfaces/subagent-surface.tsx';
export { SubagentSurface } from './surfaces/subagent-surface.tsx';
export { SvgSurface } from './surfaces/svg-surface.tsx';
export type { TerminalSurfaceProps } from './surfaces/terminal-surface.tsx';
export { TerminalSurface } from './surfaces/terminal-surface.tsx';
export type {
  EditAnimationSpec,
  EditAnimationState,
  OffscreenProbe,
} from './surfaces/use-edit-animation.ts';
export { useEditAnimation } from './surfaces/use-edit-animation.ts';
// Canvas-local chrome icons (pdf/subagent/expand/minimize/panel-toggle/download/nav)
export {
  IconAppGeneric,
  IconArrowLeft,
  IconArrowRight,
  IconCode,
  IconDisplay,
  IconDownload,
  IconExpand,
  IconFilm,
  IconFolder,
  IconFolders,
  IconMarkup,
  IconMinimize,
  IconPanelRight,
  IconPdf,
  IconPopout,
  IconSubagent,
} from './tab-icons.tsx';
// Per-tab operation bar (breadcrumb / file-tree / open-with; browser nav; media)
export type { CanvasOperationBarProps } from './tabs/canvas-operation-bar.tsx';
export {
  CanvasOperationBar,
  deriveBreadcrumb,
  fileViewModeDefault,
  hasViewToggle,
  isMarkdownFile,
  viewModeDefault,
} from './tabs/canvas-operation-bar.tsx';
// Tabbed canvas (THEME 1)
export type { CanvasTabsHandlers, CanvasTabsProps, NewTabKind } from './tabs/canvas-tabs.tsx';
export { CanvasTabs } from './tabs/canvas-tabs.tsx';
export type { CanvasControllerOptions } from './tabs/controller.ts';
export { CanvasController, createCanvasController } from './tabs/controller.ts';
// Filterable file-tree panel (file operation bar)
export type { FileTreeProps } from './tabs/file-tree.tsx';
export { FileTree, filterFileTree } from './tabs/file-tree.tsx';
// Project picker (📁 <project> chip → search dropdown)
export type { ProjectPickerItem, ProjectPickerProps } from './tabs/project-picker.tsx';
export { ProjectPicker } from './tabs/project-picker.tsx';
export type { CanvasTabKindMeta } from './tabs/tab-kinds.ts';
export { CANVAS_TAB_KINDS, kindOpensInCanvas } from './tabs/tab-kinds.ts';
export type {
  CanvasState,
  CanvasTab,
  CanvasTabKind,
  CanvasTabSpec,
  FileTreeNode,
  FileViewMode,
  OpenWithApp,
  OpenWithAppId,
  SubagentItem,
} from './tabs/tab-model.ts';
export { emptyCanvasState } from './tabs/tab-model.ts';
export type { CanvasProviderProps, CanvasTabsApi } from './tabs/use-canvas-tabs.tsx';
export { CanvasProvider, useCanvasTabs } from './tabs/use-canvas-tabs.tsx';
