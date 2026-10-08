/**
 * The real chat app: a 3-region layout (session sidebar · top bar · thread +
 * composer) wired to pi. Spawns the pi session on mount, keeps pi's model list
 * fresh for the footer, and hosts the blocking-dialog + toast surfaces.
 *
 * Round-3: the sidebar slides in/out (its slot collapses so the surface reclaims
 * the space, #A6); the empty state centers the greeting + composer vertically
 * (#A3); the collapse control lives in the sidebar just right of the traffic
 * lights (#A5); files can be dropped anywhere in the window (#A8).
 */
import {
  type CanvasController,
  CanvasProvider,
  createCanvasController,
  IconPanelRight,
  replayableEvents,
} from '@pi-desktop/canvas';
import type { Model } from '@pi-desktop/engine';
import {
  IconButton,
  IconGears,
  IconSidebar,
  MainSurface,
  OpenUrlProvider,
  SiteIconProvider,
  TopBar,
} from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHROME_LEFT, TOP_BAR_HEIGHT } from '../../electron/window-chrome';
import { conversationNameFrom } from '../../electron/workspace/project-dir';
import { lazyRoute } from '../RouteBoundary';
import type { SettingsSection } from '../settings/SettingsView';
import { registerCanvasController, useCanvasStore } from '../state/canvas-store';
import { productionHome } from '../state/chat-jobs';
import { useChildAgentStore } from '../state/child-agent-store';
import { resetCorpChildren, syncCorpChildren } from '../state/corp-child-bridge';
import {
  askCorpTask,
  attachCorpTask,
  type CorpTaskHandle,
  startCorpTask,
} from '../state/corp-connect';
import { useCorpStore } from '../state/corp-store';
import { useModalityStore } from '../state/modality-store';
import {
  getModels,
  newSession,
  setSessionName,
  startPi,
  switchSession,
  syncWorkspace,
} from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { connectPresent } from '../state/present-store';
import { useProjectStore } from '../state/project-store';
import { applySavedHarnessConfig, useUserMode } from '../state/settings-store';
import { useTaskTray } from '../state/task-tray';
import { useStudioUiStore } from '../studio/studio-ui-store';
import { AdvancedParamsPanel } from './AdvancedParamsPanel';
import { AskCard } from './AskCard';
import { preloadFastestModel } from './auto-router';
import { BobbleMark } from './BobbleMark';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { ChatTitle } from './ChatTitle';
import { ChildChatView } from './ChildChatView';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { CanvasErrorBoundary } from './canvas/CanvasErrorBoundary';
import { CanvasTabsPanel } from './canvas/CanvasTabsPanel';
import { trackChromeCorner } from './chrome-corner';
import { CorpDebugHud } from './corp/CorpDebugHud';
import { EngineMenu } from './EngineMenu';
import { GuardianBanner } from './GuardianBanner';
import { useHarnessTitleSync } from './harness-title';
import { InputNeededBanner } from './InputNeededBanner';
import { ModuleNotice } from './ModuleNotice';
import { SessionSidebar } from './SessionSidebar';
import { StageAnnouncer } from './StageAnnouncer';
import { useSiteIcon } from './site-icons';
import { TaskTray } from './TaskTray';
import { ToastHost } from './ToastHost';
import { TopBarStatus } from './TopBarStatus';
import { WhyQueuedModal } from './WhyQueuedModal';
import { WindowDropOverlay } from './WindowDropOverlay';

/**
 * Round-8 #11/#16: the chat top-right holds EXACTLY ONE control — the canvas
 * open/close toggle — and only while the canvas is CLOSED (panel icon → open).
 * Once the canvas is open, its own top-right carries the toggle (an X), so this
 * one hides: there is never a duplicate toggle and never a terminal icon here.
 * Rendered INSIDE `<CanvasProvider>` so it can reach the shared open state.
 */
/**
 * The studio's two openers, in the two places the app already puts them.
 *
 * the user: the settings rail should open from "the same place and icon as canvas",
 * and the gears from "the same place and icon as advanced settings". So they
 * are literally that cluster, swapped in while a studio is the content — the
 * canvas has nothing to show in a studio, and two panel toggles fighting over
 * one corner would be a coin flip every time.
 */
/*
 * The 3D studio's two controls, loaded only when that studio is. Importing them
 * eagerly would pull the whole tripo chunk into the boot path for a pair of
 * buttons almost nobody sees.
 */
/* `lazyRoute` so a chunk that will not fetch costs the app these two buttons
 * and nothing else — see RouteBoundary.tsx. `inline` because a card in the top
 * bar would be a worse failure than the one it is reporting. */
const StudioEngineChip = lazyRoute('3D engine chip', () => import('../tripo/StudioEngineChip'), {
  pick: (m) => m.StudioEngineChip,
  variant: 'inline',
});
const TripoTopBarControls = lazyRoute('3D controls', () => import('../tripo/TopBar'), {
  pick: (m) => m.TripoTopBarControls,
  variant: 'inline',
});

/** The name each studio wears in the top bar. */
const STUDIO_TITLES: Record<string, string> = {
  '3d': '3D Studio',
  image: 'Image Studio',
  video: 'Video Studio',
  audio: 'Audio Studio',
};

function StudioTopBarControls() {
  const settingsOpen = useStudioUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useStudioUiStore((s) => s.setSettingsOpen);
  const advancedOpen = useStudioUiStore((s) => s.advancedOpen);
  const setAdvancedOpen = useStudioUiStore((s) => s.setAdvancedOpen);
  return (
    <>
      <IconButton
        aria-label="Advanced settings"
        aria-pressed={advancedOpen}
        data-testid="studio-advanced-toggle"
        onClick={() => setAdvancedOpen(!advancedOpen)}
      >
        <IconGears />
      </IconButton>
      <IconButton
        aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
        aria-pressed={settingsOpen}
        data-testid="studio-settings-toggle"
        onClick={() => setSettingsOpen(!settingsOpen)}
      >
        <IconPanelRight />
      </IconButton>
    </>
  );
}

function CanvasTopBarControls() {
  const canvasOpen = useCanvasStore((s) => s.canvasOpen);
  const toggleCanvasOpen = useCanvasStore((s) => s.toggleCanvasOpen);
  if (canvasOpen) return null;
  return (
    <IconButton
      aria-label="Open canvas"
      aria-pressed={false}
      data-testid="canvas-toggle"
      onClick={() => toggleCanvasOpen()}
    >
      <IconPanelRight />
    </IconButton>
  );
}

/**
 * Power-user only (userMode === 'power'): the brain/gear entry to the advanced
 * parameters panel (sampling + reasoning knobs + the live ground-truth context).
 * Hidden entirely in simple ('user') mode, so a normal install never sees it.
 */
function AdvancedParamsButton() {
  const power = useUserMode() === 'power';
  const [open, setOpen] = useState(false);
  if (!power) return null;
  return (
    <>
      <IconButton
        aria-label="Advanced parameters"
        aria-pressed={open}
        data-testid="advanced-params-toggle"
        onClick={() => setOpen(true)}
      >
        <IconGears />
      </IconButton>
      <AdvancedParamsPanel open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ChatApp({
  contentOverride,
  contentTitle,
  onOpenSettings,
  onOpenConnectors,
  onOpenScheduled,
  onEnterChat,
}: {
  /** Render this INSTEAD of the thread + composer, keeping the shell. */
  contentOverride?: ReactNode;
  /** What the top bar should call it. A content route owns the title while it is
   * up; a chat's own (renameable) name comes back when it comes down. */
  contentTitle?: string;
  onOpenSettings: (section: SettingsSection) => void;
  onOpenConnectors: () => void;
  onOpenScheduled: () => void;
  /** The user navigated to a conversation — whoever owns `contentOverride`
      needs to take it down, or the chat opens invisibly behind it. */
  onEnterChat?: () => void;
}) {
  const messageCount = usePiStore((s) => s.messages.length);
  const queuedCount = usePiStore((s) => s.queuedSends.length);
  const windowTitle = usePiStore((s) => s.windowTitle);
  // Remount the composer on each session boundary so its editor text + attachments
  // don't leak across chats (BUG: switching chats retained the input state).
  const sessionEpoch = usePiStore((s) => s.sessionEpoch);
  const modelId = usePiStore((s) => s.agent.model?.id ?? null);

  // Consume the harness's auto-generated conversation title → session title
  // (new chats get a real name; a user rename is never clobbered).
  useHarnessTitleSync();
  const [piModels, setPiModels] = useState<Model[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /*
   * The corner beside the traffic lights publishes its own width, so the
   * collapsed top bar's title starts after whatever is actually in it rather
   * than after a number somebody typed once. See chrome-corner.ts.
   */
  const chromeCornerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const zone = chromeCornerRef.current;
    if (zone === null) return;
    return trackChromeCorner(
      zone,
      (px) => document.documentElement.style.setProperty('--pd-chrome-corner', `${px}px`),
      (cb) => {
        const ro = new ResizeObserver(cb);
        ro.observe(zone);
        window.addEventListener('resize', cb);
        return () => {
          ro.disconnect();
          window.removeEventListener('resize', cb);
        };
      },
    );
  }, []);

  /*
   * THE SIDEBAR STAYS WHERE YOU LEFT IT.
   *
   * A studio used to close it on arrival — the user asked for that, then asked for
   * it back: "do not auto close the left sidebar upon studio focusing". The
   * reason it reads better this way is that the studios are a CONTENT route, not
   * a takeover: switching from a chat to the Image Studio is the same kind of
   * move as switching between two chats, and neither should rearrange the
   * furniture. The sidebar is the user's setting, and closing it for them means
   * they have to put it back every time they visit.
   */
  const modality = useModalityStore((s) => s.view);
  const inStudio = modality !== 'chat';

  /*
   * WHETHER THE CHAT IS ON SCREEN, for the task tray. A studio, the model hub,
   * Scheduled and Extensions all arrive through `contentOverride`, and a chat
   * whose reply is still streaming behind one of them has been LEFT exactly as
   * much as one you switched away from (state/task-tray.ts).
   */
  const chatCovered = contentOverride !== undefined;
  useEffect(() => {
    useTaskTray.getState().setCovered(chatCovered);
  }, [chatCovered]);
  /* A chat row in the tray: the same two steps a sidebar row takes — bring the
     chat forward over whatever route is up, then open it. */
  const openChatFromTray = useCallback(
    (file: string) => {
      onEnterChat?.();
      void switchSession(file);
    },
    [onEnterChat],
  );

  /*
   * ⌘K — one way in, instead of a growing table of keys.
   *
   * The actions live HERE because the shell owns them: opening settings, the
   * connectors gallery, the scheduled view. The palette knows how to find
   * chats and commands on its own.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const paletteActions = useMemo(
    (): PaletteAction[] => [
      { id: 'new-chat', label: 'New chat', hint: '⌘N', run: () => void newSession() },
      { id: 'settings', label: 'Settings', run: () => onOpenSettings('personalization') },
      { id: 'models', label: 'Models', run: () => onOpenSettings('models') },
      { id: 'connectors', label: 'Extensions', run: onOpenConnectors },
      { id: 'scheduled', label: 'Scheduled tasks', run: onOpenScheduled },
      {
        id: 'sidebar',
        label: sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar',
        run: () => setSidebarOpen((v) => !v),
      },
    ],
    [onOpenSettings, onOpenConnectors, onOpenScheduled, sidebarOpen],
  );
  const [truncatedNote, setTruncatedNote] = useState(false);

  // Load the persisted project (working folder) first, then spawn the window's
  // pi session rooted at it (so the initial session adopts the active project's
  // cwd, round-8 #15), then push any saved harness config (permission/effort),
  // then preload the FASTEST downloaded model so a model is ALWAYS resident with
  // the lowest TTFT (round-A #4; a no-op unless Auto + something downloaded + no
  // server yet). Preload runs last so it respawns pi onto the just-started session.
  useEffect(() => {
    void useProjectStore
      .getState()
      .load()
      .then(async () => {
        /*
         * SPAWN PI AT THE WORKSPACE, not at the conversation sandbox.
         *
         * Retargeting the harness's tools was not enough: main still rooted the
         * pi child at ~/.pi/desktop/sandbox/<uuid> when no project was selected,
         * so that directory (and `_fallback`) kept appearing. MEASURED after
         * purging 455 of them — two came straight back on the next launch.
         *
         * Nothing was WRITTEN there, because our tools resolve their own root.
         * But pi's cwd is the fallback for anything that does not go through
         * them, which is the same silent-relocation shape this whole change
         * exists to remove.
         */
        const selected = useProjectStore.getState().activePath;
        /*
         * A NAMELESS CHAT DOES NOT GET A FOLDER YET.
         *
         * This used to resolve a workspace at boot under the literal name
         * "new chat", which created `~/Bobble/new-chat` and rooted pi there —
         * undoing `ensureChatWorkspace`, whose entire point is that "a chat you
         * open and abandon leaves NOTHING". It also broke the cold start:
         * pi recorded that folder as its session's cwd, the first message
         * renamed it to the message's own slug, and the model preload's restart
         * then failed to resume a session whose directory had moved. MEASURED on
         * a fresh profile — pi exits 1, the app respawns it with ALL EXTENSIONS
         * DISABLED, and "The assistant stopped" appears 416ms after the user
         * pressed enter on their first ever message.
         *
         * With a project selected the answer is known and nothing is deferred.
         * Without one, pi starts in `~/Bobble` (main's resolveSessionCwd) and the
         * chat's own folder is made on its first send, named from what was
         * actually said.
         */
        const cwd =
          selected !== null && selected !== ''
            ? ((await syncWorkspace({ selected, conversationName: 'new chat' })) ?? selected)
            : undefined;
        return startPi(cwd !== undefined && cwd !== null ? { cwd } : {});
      })
      .then(() => applySavedHarnessConfig())
      .then(() => preloadFastestModel());
  }, []);

  /*
   * THE DROPDOWN MOVED — move the work with it, live.
   *
   * Watching `activePath` rather than patching each handler covers every route
   * into a selection: picking a folder, picking a sidebar project, and clearing
   * back to "No project". Re-resolving on the chat's TITLE too, because a
   * projectless chat's folder is named from it and the title arrives after the
   * first turn.
   *
   * No respawn: `/harness workspace` retargets the file tools and bash on their
   * next call.
   */
  const activeProjectPath = useProjectStore((s) => s.activePath);
  /*
   * The name comes from the FIRST USER MESSAGE, not the generated title.
   *
   * The title would read better but does not exist yet — it is derived from that
   * same first message, and by the time it arrives a corp run has already
   * written into the placeholder, which correctly blocks the rename. Measured:
   * every clean run ended stuck at `~/Bobble/new-chat`. The first message is
   * there the instant the user hits enter, before any tool runs.
   */
  const firstUserText = usePiStore((s) => s.messages.find((m) => m.kind === 'user')?.text ?? '');
  /* Reopened (it has a reply) or just started, and the session file that names
     it across launches — the folder is the chat's, not the window's. */
  const resumedChat = usePiStore((s) => s.messages.some((m) => m.kind === 'assistant'));
  const chatSessionFile = usePiStore((s) => s.session?.sessionFile ?? '');
  const projectsLoaded = useProjectStore((s) => s.loaded);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatSessionFile re-runs it once the chat's session file is known, so main records which folder is this chat's (syncWorkspace reads it from the store)
  useEffect(() => {
    /*
     * WAIT FOR THE PROJECT STORE. `load()` is async, so resolving before it
     * settles means briefly believing there is no project — which created a
     * stray ~/Bobble/new-chat on EVERY launch, even for users who have a project
     * selected. Measured: two resolutions a millisecond apart, `bobble-default`
     * then `project-dropdown`.
     */
    if (!projectsLoaded) return;
    /*
     * NOTHING IS CREATED FOR A CHAT NOBODY HAS TYPED IN YET.
     *
     * the user: "a bunch of project clutter even though there are literally no
     * projects", and "many duplicate chats … named the same thing". MEASURED on
     * his machine: 199 folders named `~/Bobble/new-chat-2 … new-chat-199`, one
     * per chat he had ever opened, each its own working directory and therefore
     * its own entry in the folder picker and its own row of "New chat" in the
     * sidebar. `resolveProjectDir` always mkdir's, and this effect ran the
     * moment a chat opened — before a single character was typed.
     *
     * A projectless chat with no first message keeps the conversation sandbox it
     * already has (sandbox.ts), which the picker and the sidebar both ignore by
     * design. The visible `~/Bobble/<name>` folder is made on the first send —
     * see `ensureChatWorkspace` — which is also the first moment a real name
     * exists, so the placeholder rename disappears with it.
     */
    if ((activeProjectPath === null || activeProjectPath === '') && firstUserText.trim() === '') {
      return;
    }
    /*
     * ONLY THE SETTLED STATE. Opening a chat loads its messages and names its
     * session a beat apart (pi-connect `switchSession`: loadViewedThread, then
     * setViewPointer), and in between the store holds one chat's messages under
     * another's session file. MEASURED 2026-10-08 (chart-reentry-probe,
     * RESTART=1): at that instant this resolved the reopened chat's name for
     * the boot session — whose folder map said the name was taken — and made an
     * empty `~/Bobble/<name>-2`. A quarter second later is past the gap; a newer
     * state cancels the older one.
     */
    const settle = setTimeout(() => {
      void syncWorkspace({
        selected: activeProjectPath,
        conversationName:
          firstUserText.trim() !== ''
            ? conversationNameFrom(firstUserText)
            : (windowTitle ?? 'new chat'),
        resumed: resumedChat,
      });
    }, 250);
    return () => clearTimeout(settle);
  }, [activeProjectPath, windowTitle, firstUserText, projectsLoaded, resumedChat, chatSessionFile]);

  // Tiny-window adaptation (adversarial finding): a narrow window lets the fixed
  // ~300px sidebar squeeze the chat and overflow the pane. Auto-collapse it below
  // this breakpoint (chosen above the window's 640px minWidth so it can actually
  // engage); the user can still reopen it manually once there's room.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 720) setSidebarOpen(false);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keep pi's model list fresh for the footer picker (refetch when the active
  // model changes — e.g. after a local model is brought online + pi restarted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelId is a re-fetch trigger, not read in the effect
  useEffect(() => {
    void getModels().then((res) => {
      if (res.success) setPiModels(res.models);
    });
  }, [modelId]);

  // App-owned canvas controller (the blessed CanvasProvider pattern — "the app
  // usually creates one and drives it"). Owning it here lets us register its
  // tab-reset with the session lifecycle so a new/switched conversation starts
  // with a clean canvas (session isolation, backlog #2).
  const canvasController = useRef<CanvasController | null>(null);
  if (canvasController.current === null)
    canvasController.current = createCanvasController({
      // Closing the LAST tab collapses the rail, whichever affordance did it —
      // the tab's own X used to leave the chat beside an empty canvas while ⌘W
      // closed it properly (the user).
      onEmpty: () => useCanvasStore.getState().setCanvasOpen(false),
    });
  // Drives the situation room's user/power labelling when a run promotes.
  const userMode = useUserMode();
  useEffect(() => {
    const controller = canvasController.current;
    if (controller === null) return;
    registerCanvasController(controller);
    // `present` needs the controller to exist before it can open anything, so it
    // is wired here rather than at module load.
    const offPresent = connectPresent();
    return () => {
      offPresent();
      registerCanvasController(null);
    };
  }, []);

  // ⌘W → close the active canvas tab (blind-test round-2 #5). The Electron menu
  // sends this instead of closing the window; ⌘⇧W / the red button close the
  // window. With the canvas closed / no tabs it is a no-op — never the window.
  useEffect(() => {
    return window.piDesktop.onEvent('app:accelerator', ({ action }) => {
      if (action !== 'close-tab') return;
      const controller = canvasController.current;
      if (controller === null || !useCanvasStore.getState().canvasOpen) return;
      const activeTabId = controller.getState().activeTabId;
      if (activeTabId === null) return;
      controller.closeTab(activeTabId);
      // Closing the last tab collapses the rail so the chat isn't left beside an
      // empty canvas.
      if (controller.getState().tabs.length === 0) {
        useCanvasStore.getState().setCanvasOpen(false);
      }
    });
  }, []);

  // EXPERIMENTAL production harness: a submitted prompt (flag on) starts a
  // CorpEngine task. The chat shows the model's live output inline the whole time
  // (ChatThread → CorpChatStream), so it reads as the ORIGINAL model answering —
  // never blanked, never taken over. The situation-room canvas tab only opens when
  // the model PROMOTES (builds a team of subagents); a solo answer never opens it.
  // The prompt is echoed as the user's bubble. Gated by ChatComposer.
  // Launch a corp run and fold its events into the store + situation room.
  // `appendUser` echoes the user's bubble for a fresh corp-mode submit; the
  // promote-tool path (the model escalated MID-chat) passes false because the
  // user's message is already in the thread.
  const bindCorp = (handle: CorpTaskHandle) => {
    // Keyed on the SESSION FILE, which is what the sidebar nests children under:
    // the chat whose CEO asked for the team (chat-jobs), which is not the chat
    // on screen when it runs in the background — and none at all for a team
    // whose chat was deleted, which is being stopped: nothing here binds it.
    const home = productionHome(handle.taskId, usePiStore.getState().session?.sessionFile ?? null);
    if (home === null) return;
    const parentId = home.parentId;
    useCorpStore.getState().setTask(handle.taskId);
    /*
     * THE TEAM SHOWS UP AS SUBCHATS. Each role is mirrored into the child-agent
     * store as the run goes, so it appears in the sidebar under this chat and
     * OPENS as a chat when clicked — the same path a spawn_subagent child takes.
     * The sidebar used to render corp rows of its own that only pinned a node in
     * the situation room, so they looked like subchats and were not.
     */
    resetCorpChildren();
    // A REPLAYABLE stream: this loop folds it into the corp store (drives the
    // inline chat feed's follow target), and the situation tab — opened late,
    // on promotion — replays the same buffered events to reconstruct its state.
    const events = replayableEvents(handle.events);
    let situationOpened = false;
    void (async () => {
      for await (const event of events) {
        if (useCorpStore.getState().taskId !== handle.taskId) return;
        // Token-level PUSH: route per-node deltas into the block accumulator the
        // inline chat feed streams from (never poll). The situation fold ignores
        // this additive type, so there's no need to also run it through foldEvent.
        if (event.type === 'worker-activity') {
          useCorpStore.getState().foldWorkerActivity(event);
          if (parentId !== '') syncCorpChildren(parentId);
          continue;
        }
        useCorpStore.getState().foldEvent(event);
        if (parentId !== '') syncCorpChildren(parentId);
        if (event.type === 'org-chart') {
          useCorpStore.getState().trackChart(event.chart);
          // Promotion = a team exists (root + subagents). Bring up the
          // situation room ONCE, the moment the corp structure initiates.
          if (!situationOpened && event.chart.nodes.length > 1) {
            situationOpened = true;
            canvasController.current?.upsertTab(`situation:${handle.taskId}`, {
              kind: 'situation',
              title: 'Subagents',
              situationEvents: events,
              situationTaskId: handle.taskId,
              situationUserMode: userMode,
            });
            useCanvasStore.getState().setCanvasOpen(true);
          }
        }
      }
    })();
  };

  const launchCorp = (echo: string, imageUris: string[], appendUser = true) => {
    if (appendUser) usePiStore.getState().appendUser(echo, imageUris);
    void startCorpTask(echo, imageUris.length > 0 ? { images: imageUris } : undefined).then(
      bindCorp,
    );
  };

  const onCorpSubmit = (echo: string, imageUris: string[]) => launchCorp(echo, imageUris, true);

  /*
   * The model called `talk_to_manager` in NORMAL chat (the user: the corp system is an
   * OPTION at high/max effort, not a mode).
   *
   * MAIN owns starting the run now, because the tool BLOCKS the CEO until the team
   * delivers — so the run has to exist before the tool can wait on it. It tells us
   * the id on `corp:attached` and we bind the situation room to it.
   *
   * This used to start the run HERE, off the promote status signal, using the last
   * USER message as the task. Two things fell out of that. The CEO got an instant
   * ack and — still holding its own tools — carried on building the thing itself
   * while the manager sat queued. And the brief the CEO had just written for its
   * manager was discarded in favour of the raw prompt, so the mesh opened with a
   * second CEO re-deriving a vision that had already been formed. One CEO, one
   * vision, and the tool result is the finished product.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindCorp is stable for the session.
  useEffect(() => {
    const off = window.piDesktop.onEvent('corp:attached', ({ taskId }) => {
      if (useCorpStore.getState().taskId === taskId) return;
      // chat-jobs heard this first (it subscribes before the app mounts): a
      // team whose chat was deleted is being stopped, so nothing attaches to it.
      if (productionHome(taskId, usePiStore.getState().session?.sessionFile ?? null) === null) {
        return;
      }
      bindCorp(attachCorpTask(taskId));
    });
    return off;
  }, []);

  // A1/A4 — a follow-up while a corp task already exists is ANSWERED by the CEO from
  // its retained context, NOT a fresh vision ceremony. The question echoes as the
  // user's bubble; the CEO's reply arrives whole over IPC and lands as an assistant
  // message. (Starting a brand-new production is "New chat".)
  const onCorpFollowUp = (question: string) => {
    const taskId = useCorpStore.getState().taskId;
    if (taskId === null) {
      onCorpSubmit(question, []);
      return;
    }
    usePiStore.getState().appendUser(question);
    void askCorpTask(taskId, question).then((answer) => {
      usePiStore.getState().appendAssistantText(answer);
    });
  };

  const title = windowTitle ?? (messageCount > 0 ? 'Chat' : 'New chat');
  // A queued (not-yet-sent) message should show the THREAD (its queued bubble), not
  // the empty greeting — otherwise a deferred send reads as a blank chat.
  const empty = messageCount === 0 && queuedCount === 0;
  // When a child agent (subagent / role) is selected in the nested dropdown, its
  // read-only chat view replaces the main thread + composer.
  const viewedChildId = useChildAgentStore((s) => s.viewedChildId);
  /* The subagent's own name for the top-bar route (the user: "eg. 'engineer 1'"). */
  const viewedChildTitle = useChildAgentStore((s) =>
    s.viewedChildId === null ? undefined : s.children[s.viewedChildId]?.title,
  );

  // ONE composer instance ACROSS the empty→thread transition (same session → stable
  // key → focus survives the first send), but a FRESH instance per session: keying on
  // `sessionEpoch` (bumped only on a session boundary, never on empty→thread) remounts
  // it on new/switch, clearing its editor text + attachments so nothing leaks chats.
  const composer = (
    <ChatComposer
      key={`composer-${sessionEpoch}`}
      piModels={piModels}
      onOpenModels={() => onOpenSettings('models')}
      onCorpSubmit={onCorpSubmit}
      onCorpFollowUp={onCorpFollowUp}
    />
  );

  /*
   * Open a search result in the app's OWN browser, in the canvas beside the
   * conversation it came from — the user: "clicking them to show their links in the
   * browser". ONE tab, reused: a results list is something you go through, and a
   * tab per link buries the chat under a browser session in four clicks.
   */
  const openResultUrl = useCallback((url: string) => {
    const controller = canvasController.current;
    if (controller === null) return;
    controller.upsertTab('websearch:result', {
      kind: 'browser',
      title: 'Browser',
      url,
    });
    useCanvasStore.getState().setCanvasOpen(true);
  }, []);

  return (
    <CanvasProvider controller={canvasController.current}>
      {/* Dev-only live activity HUD — explicit opt-in via ?corphud
          (PI_DESKTOP_CORP_HUD=1), NOT the corp feature flag, so a normal corp run
          shows no debug overlay. Still exposes __corpStore under ?piE2E for probes. */}
      <CorpDebugHud />
      {/* Search-result rows resolve their site's icon through main (the CSP
          forbids remote images) and open in the canvas browser when clicked. */}
      <SiteIconProvider value={useSiteIcon}>
        <OpenUrlProvider value={openResultUrl}>
          <div className="relative flex h-full">
            {/* The slot owns the sidebar's footprint: its width animates to 0 on
            collapse so the main surface reclaims the space, and it clips while it
            does. The panel inside slides out on the same curve and unmounts after
            (SessionSidebar's `data-sliding`) — there is no icon rail. */}
            {/* What a screen reader hears while the model works — stage
                transitions only, never tokens. Mounted at the SHELL rather than
                in the thread: a live region that appears at the same moment as
                the thing it is announcing has already missed it. */}
            <StageAnnouncer />
            <CommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              actions={paletteActions}
              onEnterChat={onEnterChat}
            />
            <div className="pd-sidebar-slot" data-open={sidebarOpen}>
              <SessionSidebar
                open={sidebarOpen}
                onTruncated={() => setTruncatedNote(true)}
                onOpenSettings={onOpenSettings}
                onOpenConnectors={onOpenConnectors}
                onOpenScheduled={onOpenScheduled}
                onEnterChat={onEnterChat}
              />
            </div>

            <MainSurface className="flex min-w-0 flex-1 flex-col">
              <TopBar
                // The rail always hosts the traffic lights now, so the top bar never
                // needs to inset for them — EXCEPT when the sidebar is COLLAPSED to the
                // narrow rail: the macOS traffic lights overhang past that ~52px rail
                // into the top bar, so the class below insets the title clear of the
                // lights (+ the rail's expand control). Expanded, the wide sidebar
                // already clears them.
                trafficLightInset={false}
                className={sidebarOpen ? undefined : 'pd-topbar--sidebar-collapsed'}
                left={
                  /*
                   * THE TITLE SAYS WHERE YOU ARE — in the one place a title
                   * already lives.
                   *
                   * This briefly grew its own "‹ Back · <name>" route, which
                   * the user rejected on sight: "you've got a duplicate back button
                   * in subchats and the new top bar one doesn't actually work…
                   * revert that new top bar thing and just remove the 'engineer
                   * 1' text from right beside the back button and instead place
                   * it where the chat name is usually."
                   *
                   * The thread already has a working Back; a second one was
                   * noise, and mine did not route. So the subagent's name simply
                   * becomes the title while you are looking at it.
                   */
                  <>
                    {inStudio || contentTitle !== undefined ? (
                      /* A studio's or a content route's name is fixed, so the title
                         is plain text here rather than the renameable ChatTitle —
                         the same slot, saying where you are, with nothing to edit.
                         Without this the top bar said "New chat" over the Model
                         hub, Scheduled and Connectors: the route was on screen and
                         the bar was still naming a conversation behind it. */
                      <span className="pd-topbar-title" data-testid="studio-title">
                        {inStudio ? STUDIO_TITLES[modality] : contentTitle}
                      </span>
                    ) : (
                      <ChatTitle
                        title={viewedChildId !== null ? (viewedChildTitle ?? 'Subagent') : title}
                        onRename={(name) => void setSessionName(name)}
                      />
                    )}
                    {/* Right of the name, on the chat and in the studios: the
                        running model is one thing for the whole app, and so is
                        its speed. the user: "to the right of the chat name, show a
                        little icon" — and, of the Model hub: "the starting up
                        and speed dial in the top bar is out of place here". A
                        content route (the hub, Scheduled, Connectors) is not
                        about a conversation, so neither the dial nor the model's
                        state belongs in its bar. */}
                    {contentTitle === undefined ? (
                      modality === '3d' ? (
                        /* The studio's engine and its steps/s, not the chat
                           model's dial (StudioEngineChip.tsx). */
                        <StudioEngineChip />
                      ) : (
                        <EngineMenu />
                      )
                    ) : null}
                    {/* (The downloads icon that stood here now lists in the task
                        tray beside the sidebar toggle, under "Downloads" —
                        the user, 2026-09-24. See state/tray-transfers.ts.) */}
                  </>
                }
                /* The app's own state — starting up, getting ready — lives in
                   the middle of the bar, between the chat's name and the
                   canvas/advanced controls, on the chat and in the studios. */
                // THE NOTICE SLOT. A chat waiting for the person, then the
                // machine's own state (paused / stopped / waiting for memory),
                // then the ordinary model status — one slot, the most urgent
                // wins; nothing floats over the page (the user: "overlap such as
                // this must be fixed on sight").
                center={
                  <InputNeededBanner
                    fallback={
                      <GuardianBanner
                        fallback={contentTitle === undefined ? <TopBarStatus /> : null}
                      />
                    }
                  />
                }
                right={
                  // The canvas toggle (round-8 #11/#16) plus, for power users only,
                  // the brain/gear advanced-params entry to its left. In simple mode
                  // the top-right is exactly the canvas toggle, unchanged.
                  //
                  <div className="flex items-center gap-2">
                    {/* In a studio the canvas has nothing to show and the chat's
                        sampling knobs are not what you are adjusting, so the two
                        buttons keep their positions and change what they open. */}
                    {modality === '3d' ? (
                      /* The 3D studio brings its own pair — Send To and Export
                         — which used to sit in a second top bar of its own.
                         Lazy, like the workspace they belong to. */
                      <TripoTopBarControls />
                    ) : inStudio ? (
                      <StudioTopBarControls />
                    ) : (
                      <>
                        <AdvancedParamsButton />
                        <CanvasTopBarControls />
                      </>
                    )}
                  </div>
                }
              />

              {/* A selected child agent (subagent / role) shows its own read-only chat
              view in place of the main thread + composer. `contentOverride` is the
              same seam for a full surface — the Model hub — so the SIDEBAR AND TOP
              BAR STAY PUT. the user: "ensure that this keeps the left sidebar present
              when clicked". Replacing the whole window for it meant losing the
              chat list, the project chip and the collapse rail, which is a lot to
              give up to look at models. */}
              {contentOverride !== undefined ? (
                contentOverride
              ) : viewedChildId !== null ? (
                <ChildChatView childId={viewedChildId} />
              ) : (
                /* One flex column that hosts BOTH states so the keyed composer slot
              below keeps the same DOM parent across empty→thread. #A3: the empty
              state centers the greeting + composer vertically. */
                <div
                  className={`flex min-h-0 flex-1 flex-col ${
                    empty ? 'pd-home items-center px-6' : ''
                  }`}
                >
                  {/*
                    THE EMPTY SCREEN SITS HIGH, NOT CENTRED. the user (2026-09-17):
                    "move the chat area upward so it's ~45% height to the bottom
                    of the screen and then place just a single line larger than
                    currently that has the app logo and then 'Bobble'". Two
                    spacers split the free height 45:55 around the block, which
                    leaves ~45% of the window under the composer.
                  */}
                  {empty ? <div key="space-top" aria-hidden className="pd-home-space-top" /> : null}
                  {empty ? (
                    <div key="lead" className="flex flex-col items-center">
                      <div className="pd-home-lead" data-testid="home-lead">
                        <BobbleMark size={48} />
                        <span className="pd-home-lead-name">Bobble</span>
                      </div>
                      {/*
                        NOT "What are we building?".

                        A tester who writes marketing emails for a living opened
                        the app, read that line, and wondered whether she had
                        downloaded a developer tool by mistake. She had, in a
                        sense: the same assumption was in the copy, in the config
                        (the per-turn class was hardcoded to `coding`) and in the
                        model's mouth — it answered "what can you actually do?"
                        with "Hello! I'm a local coding agent". Her words: "that
                        greeting, the hardcoded coding preset, and the tool list
                        are the same mistake in three different layers."

                        Fixing one layer would just have moved the tell, so all
                        three moved together.
                      */}
                      {/*
                        "How can I help you today?" and the privacy claim
                        ("Nothing you type here leaves this Mac. Only web
                        searches do.") used to sit under the name; the user asked
                        for the one line, so they are gone from here.
                      */}
                      {/*
                        ROOM FOR THE PILL. It floats 8px above the input card and
                        landed on top of this line — the user drew an arrow at it.
                        Reserving the space here rather than raising the pill
                        keeps the rule that it never moves the card when it
                        appears, and it cannot collide with anything else later.
                      */}
                      <div aria-hidden className="h-7" data-testid="pill-gutter" />
                    </div>
                  ) : (
                    // The thread is ALWAYS the lead surface — a corp run renders
                    // inline inside it (CorpInlineTurn) instead of swapping it out.
                    <div key="lead" className="flex min-h-0 flex-1 flex-col">
                      <ChatThread />
                    </div>
                  )}
                  <div key="composer-slot" className={empty ? 'w-full' : 'shrink-0 px-4 pb-4 pt-2'}>
                    {!empty && truncatedNote ? (
                      <div className="mx-auto mb-2 max-w-[700px] text-caption text-text-muted">
                        Restored an earlier session; some history was truncated.
                      </div>
                    ) : null}
                    {/* A generation the model asked for that this Mac cannot make
                  yet: the Download button, right where the reply is waited for. */}
                    <ModuleNotice />
                    {/* Every question to the person — a permission, a yes/no, the
                  model's ask_user — as one card just above the composer. */}
                    <AskCard />
                    {/* Round-12 W2: the project (working-folder) chip moved OFF the
                  top of the composer into the sticking-out ComposerBar below the
                  input (mounted inside ChatComposer). */}
                    {composer}
                  </div>
                  {empty ? (
                    <div key="space-bottom" aria-hidden className="pd-home-space-bottom" />
                  ) : null}
                </div>
              )}
            </MainSurface>

            {/*
             * THE SIDEBAR TOGGLE LIVES HERE, not in the sidebar.
             *
             * the user: "move the left sidebar button right to the right of the
             * traffic light buttons… button stays fixed up right next to the
             * traffic light buttons." A collapsed sidebar now unmounts entirely,
             * so a toggle rendered by it would vanish with it and leave no way
             * back.
             *
             * WHY IT IS RENDERED LAST AND WRAPPED. the user: "the left sidebar
             * button is NOT CLICKABLE doesn't have any hover or click."
             *
             * `no-drag` on the button was not enough. macOS takes mouse events
             * inside a `-webkit-app-region: drag` rect BEFORE the renderer sees
             * them, so a covered control loses its clicks AND its hover — the
             * missing hover is what proves the events never arrived, and it is
             * why a Playwright click "passed": CDP injects at the renderer,
             * below the layer that was eating real input.
             *
             * `.pd-sidebar-tl` is a full-width drag strip across the sidebar's
             * top, and it overlapped this button exactly. Chromium unions and
             * subtracts these rects in paint order, so the fix is both halves:
             * the strips no longer extend over this corner (global.css), and the
             * toggle sits in its own `no-drag` zone painted after everything so
             * nothing can re-add drag on top of it.
             */}
            {/*
              BESIDE THE TRAFFIC LIGHTS, NOT NEAR THEM.
              `left` and the strip's height come from `window-chrome.ts` — the
              same module main passes to `trafficLightPosition` — so the toggle
              tracks the lights instead of a hand-tuned `left-[78px]` that had no
              relationship to them. Centring the strip on the bar's own height
              puts the button on the cluster's centre line without anyone having
              to state that line twice. the user: "vertically raise/align the
              open/close sidebar button and move it slightly to the right so the
              hover animation gives breathing room and doesn't overlap".
            */}
            <div
              ref={chromeCornerRef}
              className="[-webkit-app-region:no-drag] absolute top-0 z-40 flex items-center"
              style={{ left: CHROME_LEFT, height: TOP_BAR_HEIGHT }}
              data-testid="sidebar-toggle-zone"
            >
              <button
                type="button"
                aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                aria-expanded={sidebarOpen}
                data-testid={sidebarOpen ? 'collapse-sidebar' : 'expand-sidebar'}
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="[-webkit-app-region:no-drag] pd-focusable flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <IconSidebar size={16} />
              </button>
              {/*
                THE TASKS YOU LEFT, immediately right of the toggle and in the
                same no-drag zone (a control outside it would lose its clicks to
                the drag rect, like the toggle once did). the user (2026-09-24): "a
                little notifications button … always simply to the right of the
                collapse sidebar button, this only appears when you leave a
                running task". Here rather than in the sidebar so it is there
                whether the sidebar is open or collapsed. See TaskTray.tsx.
              */}
              <TaskTray onOpenChat={openChatFromTray} />
              {/*
                CHAT | WORK, in the corner Claude puts it in.

                the user: "claude has this little thing in the top left that I think
                we can lift off of … and that toggles that bottom bar popping
                out, left one being 'chat' and right being 'work'."

                In the same `no-drag` zone as the sidebar toggle, deliberately:
                that zone exists because macOS eats mouse events inside a drag
                rect before the renderer sees them, and a second control in the
                same corner would hit the identical bug on its own.
              */}
              {/* The Chat|Work toggle lived here until 2026-09-21 — the user:
                  "remove chat vs work, just leave it on 'work'". The ledge is
                  simply there now. */}
            </div>

            <CanvasErrorBoundary>
              <CanvasTabsPanel suppressed={contentOverride !== undefined} />
            </CanvasErrorBoundary>

            {/* No composer on screen (a studio, the hub, a subagent): the same
                card floats at the window's foot instead. */}
            {contentOverride !== undefined || viewedChildId !== null ? (
              <AskCard placement="floating" />
            ) : null}
            <WhyQueuedModal />
            <ToastHost />
            <WindowDropOverlay />
          </div>
        </OpenUrlProvider>
      </SiteIconProvider>
    </CanvasProvider>
  );
}
