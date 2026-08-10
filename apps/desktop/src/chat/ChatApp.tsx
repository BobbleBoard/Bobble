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
  IconClose,
  IconGears,
  MainSurface,
  OpenUrlProvider,
  SiteIconProvider,
  TopBar,
} from '@pi-desktop/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsSection } from '../settings/SettingsView';
import { registerCanvasController, useCanvasStore } from '../state/canvas-store';
import { useChildAgentStore } from '../state/child-agent-store';
import { resetCorpChildren, syncCorpChildren } from '../state/corp-child-bridge';
import {
  askCorpTask,
  attachCorpTask,
  type CorpTaskHandle,
  startCorpTask,
} from '../state/corp-connect';
import { useCorpStore } from '../state/corp-store';
import { getModels, setSessionName, startPi, syncWorkspace } from '../state/pi-connect';
import { conversationNameFrom } from '../../electron/workspace/project-dir';
import { usePiStore } from '../state/pi-slice';
import { connectPresent } from '../state/present-store';
import { useProjectStore } from '../state/project-store';
import { applySavedHarnessConfig, useUserMode } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { AdvancedParamsPanel } from './AdvancedParamsPanel';
import { preloadFastestModel } from './auto-router';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { ChatTitle } from './ChatTitle';
import { ChildChatView } from './ChildChatView';
import { CanvasTabsPanel } from './canvas/CanvasTabsPanel';
import { CorpDebugHud } from './corp/CorpDebugHud';
import { useHarnessTitleSync } from './harness-title';
import { InputNeededBanner } from './InputNeededBanner';
import { SessionSidebar, type SidebarStub } from './SessionSidebar';
import { useSiteIcon } from './site-icons';
import { ToastHost } from './ToastHost';
import { UiRequestDialogs } from './UiRequestDialogs';
import { WhyQueuedModal } from './WhyQueuedModal';
import { WindowDropOverlay } from './WindowDropOverlay';

/**
 * Round-8 #11/#16: the chat top-right holds EXACTLY ONE control — the canvas
 * open/close toggle — and only while the canvas is CLOSED (panel icon → open).
 * Once the canvas is open, its own top-right carries the toggle (an X), so this
 * one hides: there is never a duplicate toggle and never a terminal icon here.
 * Rendered INSIDE `<CanvasProvider>` so it can reach the shared open state.
 */
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

const STUB_COPY: Record<SidebarStub, { title: string; body: string }> = {
  projects: {
    title: 'Projects',
    body: 'Group chats, files, and context into projects. Coming soon.',
  },
  scheduled: {
    title: 'Scheduled tasks',
    body: 'Run Pi on a schedule and review the results. Coming soon.',
  },
  skills: { title: 'Skills', body: 'Browse and manage the skills Pi can use. Coming soon.' },
};

/** A lightweight "coming soon" overlay for nav destinations without a page yet. */
function StubPanel({ stub, onClose }: { stub: SidebarStub; onClose: () => void }) {
  const { title, body } = STUB_COPY[stub];
  return (
    <div className="pd-stub-overlay" data-testid="stub-panel">
      <div className="pd-stub-card">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-heading text-text-primary">{title}</h2>
          <IconButton aria-label="Close" onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>
        <p className="text-body text-text-muted">{body}</p>
      </div>
    </div>
  );
}

export function ChatApp({
  onOpenSettings,
  onOpenConnectors,
}: {
  onOpenSettings: (section: SettingsSection) => void;
  onOpenConnectors: () => void;
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
  const flavor = useThemeStore((s) => s.flavor);
  const [piModels, setPiModels] = useState<Model[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [truncatedNote, setTruncatedNote] = useState(false);
  const [stub, setStub] = useState<SidebarStub | null>(null);

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
        const cwd =
          (await syncWorkspace({ selected, conversationName: 'new chat' })) ??
          selected ??
          undefined;
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
  const projectsLoaded = useProjectStore((s) => s.loaded);
  useEffect(() => {
    /*
     * WAIT FOR THE PROJECT STORE. `load()` is async, so resolving before it
     * settles means briefly believing there is no project — which created a
     * stray ~/Bobble/new-chat on EVERY launch, even for users who have a project
     * selected. Measured: two resolutions a millisecond apart, `bobble-default`
     * then `project-dropdown`.
     */
    if (!projectsLoaded) return;
    void syncWorkspace({
      selected: activeProjectPath,
      conversationName:
        firstUserText.trim() !== '' ? conversationNameFrom(firstUserText) : (windowTitle ?? 'new chat'),
    });
  }, [activeProjectPath, windowTitle, firstUserText, projectsLoaded]);

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
    useCorpStore.getState().setTask(handle.taskId);
    /*
     * THE TEAM SHOWS UP AS SUBCHATS. Each role is mirrored into the child-agent
     * store as the run goes, so it appears in the sidebar under this chat and
     * OPENS as a chat when clicked — the same path a spawn_subagent child takes.
     * The sidebar used to render corp rows of its own that only pinned a node in
     * the situation room, so they looked like subchats and were not.
     */
    resetCorpChildren();
    // Keyed on the SESSION FILE, which is what the sidebar nests children under.
    const parentId = usePiStore.getState().session?.sessionFile ?? '';
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
              title: 'Situation room',
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
          <div className="flex h-full">
            {/* The sidebar stays mounted; when collapsed the slot narrows to a
            ~64px ICON RAIL (round-8 #1) rather than hiding — global.css owns the
            rail width + the panel's stay-put override. */}
            <div className="pd-sidebar-slot" data-open={sidebarOpen}>
              <SessionSidebar
                open={sidebarOpen}
                onCollapse={() => setSidebarOpen(false)}
                onExpand={() => setSidebarOpen(true)}
                onTruncated={() => setTruncatedNote(true)}
                onOpenSettings={onOpenSettings}
                onOpenConnectors={onOpenConnectors}
                onOpenStub={setStub}
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
                  // The chat title sits just RIGHT of the sidebar/rail (#13). The
                  // rail carries its own expand toggle, so no top-bar sidebar button.
                  <ChatTitle title={title} onRename={(name) => void setSessionName(name)} />
                }
                right={
                  // The canvas toggle (round-8 #11/#16) plus, for power users only,
                  // the brain/gear advanced-params entry to its left. In simple mode
                  // the top-right is exactly the canvas toggle, unchanged.
                  <div className="flex items-center gap-1">
                    <AdvancedParamsButton />
                    <CanvasTopBarControls />
                  </div>
                }
              />

              {/* A selected child agent (subagent / role) shows its own read-only chat
              view in place of the main thread + composer. */}
              {viewedChildId !== null ? (
                <ChildChatView childId={viewedChildId} />
              ) : (
                /* One flex column that hosts BOTH states so the keyed composer slot
              below keeps the same DOM parent across empty→thread. #A3: the empty
              state centers the greeting + composer vertically. */
                <div
                  className={`flex min-h-0 flex-1 flex-col ${
                    empty ? 'items-center justify-center gap-6 px-6' : ''
                  }`}
                >
                  {empty ? (
                    <div key="lead" className="flex flex-col items-center gap-2">
                      <h1 className="text-title">Bobble</h1>
                      <p className="text-body text-text-muted">
                        {flavor === 'claude'
                          ? 'How can I help you today?'
                          : 'What are we building?'}
                      </p>
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
                    {/* Round-12 W2: the project (working-folder) chip moved OFF the
                  top of the composer into the sticking-out ComposerBar below the
                  input (mounted inside ChatComposer). */}
                    {composer}
                  </div>
                </div>
              )}

              {stub !== null ? <StubPanel stub={stub} onClose={() => setStub(null)} /> : null}
            </MainSurface>

            <CanvasTabsPanel />

            <UiRequestDialogs />
            <InputNeededBanner />
            <WhyQueuedModal />
            <ToastHost />
            <WindowDropOverlay />
          </div>
        </OpenUrlProvider>
      </SiteIconProvider>
    </CanvasProvider>
  );
}
