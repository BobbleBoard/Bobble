import { CanvasProvider, createCanvasController } from '@pi-desktop/canvas';
import { Spinner, ToastProvider, TooltipProvider } from '@pi-desktop/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { AppInfo } from '../electron/ipc-contract';
import { CandidatesRoute, candidateSet } from './candidates/CandidatesRoute';
import { ChatApp } from './chat/ChatApp';
import { CanvasPopoutView } from './chat/canvas/CanvasPopoutView';
import { useGenStream } from './chat/gen-stream';
import { ConnectorsScreen } from './connectors/ConnectorsScreen';
import { SituationDemoView } from './demo/SituationDemoView';
import { GalleryView } from './gallery/GalleryView';
import { ModelsView } from './models/ModelsView';
import { FirstRunTips, resetFirstRunTips } from './onboarding/FirstRunTips';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { ScheduledView } from './scheduled/ScheduledView';
import { startTaskRunner } from './scheduled/tasks-store';
import { type SettingsSection, SettingsView } from './settings/SettingsView';
import { exitModality, useModalityStore } from './state/modality-store';
import { newSession } from './state/pi-connect';
import { usePiStore } from './state/pi-slice';
import { applyThemeAttributes, useThemeStore } from './store/theme';

/** First-run gate status: unknown until onboarding:get-state resolves. */
type GateStatus = 'loading' | 'onboarding' | 'ready';

/** The standalone canvas pop-out window loads with `?canvasPopout=1`. */
const IS_CANVAS_POPOUT = new URLSearchParams(window.location.search).has('canvasPopout');

/**
 * Dev-only candidate designs (`?candidates=schedule` / `?candidates=connectors`).
 * They exist so a new design can be built and LOOKED AT without the shipping
 * screen changing under anyone — the user: "these UI's are not to immediately
 * replace anything but keep the current ones safe."
 */
const CANDIDATE_SET = candidateSet(window.location.search);

/** Dev/demo route: the situation room driven by the scripted mock corp run. */
const IS_SITUATION_DEMO = new URLSearchParams(window.location.search).has('situationDemo');

/** UI-only preview route: the Tripo-style 3D workspace (`?tripo=1`, dev
 * override PI_DESKTOP_TRIPO=1). Lazy so the workspace stays out of the main
 * bundle for every normal launch. */
const IS_TRIPO = new URLSearchParams(window.location.search).has('tripo');
const TripoWorkspace = lazy(() =>
  import('./tripo/TripoWorkspace').then((m) => ({ default: m.TripoWorkspace })),
);
const TripoTopBarControls = lazy(() =>
  import('./tripo/TopBar').then((m) => ({ default: m.TripoTopBarControls })),
);
/** The ComfyUI-backed image/video Studio. Lazy for the same reason. */
const ImageStudio = lazy(() =>
  import('./studio/ImageStudio').then((m) => ({ default: m.ImageStudio })),
);
const VideoStudio = lazy(() =>
  import('./studio/VideoStudio').then((m) => ({ default: m.VideoStudio })),
);
const AudioStudio = lazy(() =>
  import('./studio/AudioStudio').then((m) => ({ default: m.AudioStudio })),
);

/**
 * Hidden probe hooks: keep the boot-event / theme / app-info testids the
 * built-app E2E probes assert on (tests/e2e/probe.mjs, packaged-probe.mjs)
 * without cluttering the real UI. sr-only, not display:none, so Playwright can
 * still read their text.
 */
function ProbeHooks() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void window.piDesktop.invoke('app:get-info', undefined).then(setInfo);
    return window.piDesktop.onEvent('app:boot', () => setBooted(true));
  }, []);

  return (
    <div className="sr-only" aria-hidden>
      <span data-testid="theme-chip">
        {flavor} / {mode}
      </span>
      <span data-testid="boot-state">
        {booted ? 'boot event received' : 'waiting for boot event…'}
      </span>
      {info !== null ? (
        <span data-testid="app-info">
          Electron {info.electronVersion} · Chrome {info.chromeVersion} · Node {info.nodeVersion}
        </span>
      ) : null}
    </div>
  );
}

/**
 * `settings` is NOT a view any more — it floats over whichever of these is
 * showing (see `settingsOpen`). `models` became one, because model management
 * is now a full surface of its own rather than a settings page.
 */
type MainView = 'chat' | 'gallery' | 'models' | 'connectors' | 'scheduled';

export function App() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const modalityView = useModalityStore((s) => s.view);
  const [view, setView] = useState<MainView>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [gate, setGate] = useState<GateStatus>('loading');

  useEffect(() => {
    applyThemeAttributes(document.documentElement, { flavor, mode });
  }, [flavor, mode]);

  /* A running generation streams its progress to the thread's inline card (it
     used to stream to a canvas tab). At app level so the job keeps reporting
     while its owner steps into a studio and back — see chat/gen-stream.ts. */
  useGenStream();

  /* E2E theme hook, on the same `?piE2E=1` opt-in as `__pi_canvas`. Probes need
   * to flip the theme to check that the native office views re-theme with the
   * app — the one thing a DOM screenshot cannot show, since those views paint
   * above the DOM and have to be captured through their own webContents. */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('piE2E')) {
      window.__pi_theme = () => useThemeStore.getState();
    }
  }, []);

  /*
   * WARM THE MODEL WHILE THE USER IS STILL READING THE SCREEN.
   *
   * The chat server was started lazily by the first SEND, so the first message
   * of every session paid for the whole cold start inside the user's turn.
   * Measured from the keypress: 12,986ms / 15,257ms / 17,292ms before a single
   * character appeared. Nothing explained the wait, so it reads as a hang.
   *
   * None of that work depends on what the user types. Starting it at mount moves
   * it into the seconds someone spends looking at an empty chat and deciding
   * what to ask, and `ensureChatServerReady` is idempotent + already guarded by
   * an in-flight promise, so the send simply finds it done.
   *
   * Deliberately not gated on onboarding finishing: a profile with no model
   * resolves to nothing and returns immediately.
   */
  /* Scheduled tasks: main tells us what is due, this runs it as a real chat.
     Wired once at app level so a task fires whatever view you are looking at. */
  useEffect(() => {
    if (IS_CANVAS_POPOUT || IS_SITUATION_DEMO || IS_TRIPO) return;
    return startTaskRunner();
  }, []);

  useEffect(() => {
    if (IS_CANVAS_POPOUT || IS_SITUATION_DEMO || IS_TRIPO) return;
    void import('./chat/auto-router')
      .then(({ ensureChatServerReady }) => ensureChatServerReady())
      .catch(() => undefined);
  }, []);

  /**
   * One entry point for "open settings at section X", because `models` is no
   * longer a settings section — it is its own view. Every existing caller (the
   * sidebar gear, the composer's model chip) keeps passing the same ids and
   * lands in the right place, which is why the id stayed in `SettingsSection`.
   */
  const openSettings = (section: SettingsSection) => {
    if (section === 'models') {
      setSettingsOpen(false);
      setView('models');
      return;
    }
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  // "Redo onboarding" (Settings → Interface): clear the persisted first-run flag,
  // re-arm the first-run tips, and re-open the wizard. Settings persist; the
  // wizard applies fresh choices live.
  const redoOnboarding = () => {
    void window.piDesktop.invoke('onboarding:reset', undefined).catch(() => undefined);
    resetFirstRunTips();
    setView('chat');
    setGate('onboarding');
  };

  // First-run gate: onboarding runs before ChatApp until the choices are
  // persisted. The boot theme is owned solely by settings.json (applied by
  // connectSettings, and seeded from onboarding.json on first read) — applying
  // the onboarding choices here too would race that and clobber a theme the user
  // has since changed via the top-bar toggle / settings panel (which write
  // settings.json, not onboarding.json). The canvas pop-out never onboards.
  useEffect(() => {
    if (IS_CANVAS_POPOUT || IS_SITUATION_DEMO || IS_TRIPO) return;
    let cancelled = false;
    window.piDesktop
      .invoke('onboarding:get-state', undefined)
      .then((state) => {
        if (cancelled) return;
        setGate(state.firstRunComplete ? 'ready' : 'onboarding');
      })
      .catch(() => {
        // If the gate can't be read, fall through to onboarding rather than
        // stranding the user on a blank screen.
        if (!cancelled) setGate('onboarding');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * `?tripo=1` — the dev route — is still a full-window takeover, because there
   * is no chat shell in that window to put it inside. The MODALITY is not: it
   * goes through `contentOverride` with the other three studios (below), which
   * is what gives it the sidebar, the toggle beside the traffic lights, and a
   * way out that is not a back button. the user: "remove the < chat button and
   * instead still keep the sidebar open/collapse button."
   */
  if (IS_TRIPO) {
    return (
      <TooltipProvider delayDuration={200}>
        <Suspense fallback={null}>
          {/*
            The dev route has no app top bar to host Send To and Export, so it
            gets a slim strip of its own. Without it this window could open a
            model and never get one out — the modality route hands those two
            buttons to the app's own cluster instead.
          */}
          <div className="tp-standalone">
            <header className="tp-standalone-bar" data-testid="tp-topbar">
              <TripoTopBarControls />
            </header>
            <TripoWorkspace />
          </div>
        </Suspense>
      </TooltipProvider>
    );
  }

  if (CANDIDATE_SET !== null) {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="h-full">
          <CandidatesRoute set={CANDIDATE_SET} />
        </div>
      </TooltipProvider>
    );
  }

  if (IS_CANVAS_POPOUT) {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="h-full">
          <CanvasPopoutView />
        </div>
      </TooltipProvider>
    );
  }

  if (IS_SITUATION_DEMO) {
    /*
     * The demo route renders the REAL corp surfaces off a scripted run, and
     * those reach for the canvas controller exactly as they do in the chat —
     * so it threw "useCanvasTabs requires a CanvasController" and painted a
     * blank window. The main path gets its provider from ChatApp; this one had
     * none. Found by driving the route to verify a UI change on it.
     */
    return (
      <TooltipProvider delayDuration={200}>
        <CanvasProvider controller={createCanvasController()}>
          <div className="h-full">
            <SituationDemoView />
          </div>
        </CanvasProvider>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider swipeDirection="right">
        <div className="h-full">
          {gate === 'loading' ? (
            <div className="flex h-full items-center justify-center text-accent-primary">
              <Spinner size={22} />
            </div>
          ) : gate === 'onboarding' ? (
            <OnboardingWizard onComplete={() => setGate('ready')} />
          ) : view === 'gallery' ? (
            <div className="flex h-full flex-col">
              {/* Left inset clears the macOS traffic lights (titleBarStyle:
                  hiddenInset ≈ 78px); the bar stays draggable, the button opts out. */}
              <div className="flex h-10 shrink-0 items-center gap-2 py-0 pr-3 pl-[80px] [-webkit-app-region:drag]">
                <button
                  type="button"
                  className="[-webkit-app-region:no-drag] text-footnote text-text-link"
                  onClick={() => setSettingsOpen(true)}
                >
                  ← Back to settings
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <GalleryView />
              </div>
            </div>
          ) : (
            <div className="relative h-full">
              {/* The Model hub renders INSIDE the chat shell so the sidebar and
                  top bar stay put — the user: "ensure that this keeps the left
                  sidebar present when clicked". It is a content route, not a
                  window takeover. */}
              <ChatApp
                onOpenSettings={openSettings}
                onOpenConnectors={() => setView('connectors')}
                onOpenScheduled={() => setView('scheduled')}
                /* Picking a chat takes the content route down. Without this the
                   hub (or Scheduled) stayed on screen while the session changed
                   underneath it — you clicked New chat and kept looking at the
                   model hub.
                   The studios ride the SAME seam now, so they have to come down
                   with it: opening the sidebar over a studio and picking a chat
                   has to land you in that chat, not leave you in the studio with
                   a different conversation loaded behind it. */
                onEnterChat={() => {
                  setView('chat');
                  exitModality();
                }}
                contentTitle={
                  modalityView === 'chat'
                    ? view === 'models'
                      ? 'Model management'
                      : view === 'scheduled'
                        ? 'Scheduled'
                        : view === 'connectors'
                          ? 'Connectors'
                          : undefined
                    : undefined
                }
                contentOverride={
                  /*
                   * THE STUDIOS ARE A CONTENT ROUTE NOW, not a window takeover.
                   *
                   * They used to `return` before the chat shell entirely, which
                   * meant entering one threw away the chat list, the top bar and
                   * every control on it — and the studio then had to reinvent a
                   * back button, a title bar and a traffic-light inset it had no
                   * business owning. the user: they should "just appear in the chat
                   * area as if they are just replacing the current chat".
                   *
                   * Same seam the model hub and Scheduled already use. The
                   * sidebar is left exactly as the user had it — see ChatApp for
                   * why that changed.
                   */
                  modalityView === '3d' ? (
                    <Suspense fallback={null}>
                      <TripoWorkspace />
                    </Suspense>
                  ) : modalityView === 'image' ? (
                    <Suspense fallback={null}>
                      <ImageStudio />
                    </Suspense>
                  ) : modalityView === 'video' ? (
                    <Suspense fallback={null}>
                      <VideoStudio />
                    </Suspense>
                  ) : modalityView === 'audio' ? (
                    <Suspense fallback={null}>
                      <AudioStudio />
                    </Suspense>
                  ) : view === 'models' ? (
                    <ModelsView />
                  ) : view === 'scheduled' ? (
                    /* Same seam as the model hub: a content route inside the chat
                       shell, so the sidebar and top bar stay put. */
                    <ScheduledView />
                  ) : view === 'connectors' ? (
                    /* ...and so is this, now. It was the one screen in that
                       sidebar section that took the window instead, which is why
                       it needed a back button and a traffic-light inset of its
                       own. See the note at the top of ConnectorsScreen. */
                    <ConnectorsScreen
                      /* "Try in chat": a NEW chat, because pi reads the
                         connector registry when a session starts, so the
                         thing just turned on is only certainly there in the
                         next one. The prompt lands in the composer through
                         the same hand-off the Edit action uses. */
                      onTryInChat={(prompt) => {
                        setView('chat');
                        exitModality();
                        void newSession().then(() => {
                          usePiStore.setState({ composerText: prompt });
                        });
                      }}
                    />
                  ) : undefined
                }
              />
              {/* Onboarding `tutorial` flag consumer: dismissible first-run tips. */}
              <FirstRunTips />
            </div>
          )}

          {/*
           * Settings FLOATS over whatever is behind it rather than replacing it
           * (the user: "not full window taking over thing, but instead floating
           * panel center"), so it is rendered as a sibling of the view switch,
           * not a branch of it. The view underneath stays mounted, which is why
           * closing settings returns you to the same chat scroll position.
           */}
          {gate === 'ready' && settingsOpen ? (
            <SettingsView
              section={settingsSection}
              onSection={openSettings}
              onClose={() => setSettingsOpen(false)}
              onOpenGallery={() => {
                setSettingsOpen(false);
                setView('gallery');
              }}
              onOpenConnectors={() => {
                setSettingsOpen(false);
                setView('connectors');
              }}
              onRedoOnboarding={() => {
                setSettingsOpen(false);
                redoOnboarding();
              }}
            />
          ) : null}
        </div>
        <ProbeHooks />
      </ToastProvider>
    </TooltipProvider>
  );
}
