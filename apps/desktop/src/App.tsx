import { CanvasProvider, createCanvasController } from '@pi-desktop/canvas';
import { Spinner, ToastProvider, TooltipProvider } from '@pi-desktop/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { AppInfo } from '../electron/ipc-contract';
import { ChatApp } from './chat/ChatApp';
import { CanvasPopoutView } from './chat/canvas/CanvasPopoutView';
import { ConnectorsScreen } from './connectors/ConnectorsScreen';
import { SituationDemoView } from './demo/SituationDemoView';
import { GalleryView } from './gallery/GalleryView';
import { ModelsView } from './models/ModelsView';
import { FirstRunTips, resetFirstRunTips } from './onboarding/FirstRunTips';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { ScheduledView } from './scheduled/ScheduledView';
import { startTaskRunner } from './scheduled/tasks-store';
import { type SettingsSection, SettingsView } from './settings/SettingsView';
import { useModalityStore } from './state/modality-store';
import { applyThemeAttributes, useThemeStore } from './store/theme';

/** First-run gate status: unknown until onboarding:get-state resolves. */
type GateStatus = 'loading' | 'onboarding' | 'ready';

/** The standalone canvas pop-out window loads with `?canvasPopout=1`. */
const IS_CANVAS_POPOUT = new URLSearchParams(window.location.search).has('canvasPopout');

/** Dev/demo route: the situation room driven by the scripted mock corp run. */
const IS_SITUATION_DEMO = new URLSearchParams(window.location.search).has('situationDemo');

/** UI-only preview route: the Tripo-style 3D workspace (`?tripo=1`, dev
 * override PI_DESKTOP_TRIPO=1). Lazy so the workspace stays out of the main
 * bundle for every normal launch. */
const IS_TRIPO = new URLSearchParams(window.location.search).has('tripo');
const TripoWorkspace = lazy(() =>
  import('./tripo/TripoWorkspace').then((m) => ({ default: m.TripoWorkspace })),
);
/** The ComfyUI-backed image/video Studio. Lazy for the same reason. */
const StudioView = lazy(() =>
  import('./studio/StudioView').then((m) => ({ default: m.StudioView })),
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

  // The 3D Studio modality: reached from the sidebar "Modalities" dropdown (or
  // the ?tripo=1 dev route). A full-window takeover with its own back-to-chat
  // button; when active it replaces the chat shell entirely.
  /*
   * THE IMAGE & VIDEO STUDIO — the same full-surface routing the 3D one uses.
   * Lazy, because it pulls nothing until someone opens it, and the boot path is
   * exactly where a few hundred kilobytes of unused view would be felt.
   */
  if (modalityView === 'studio') {
    return (
      <TooltipProvider delayDuration={200}>
        <Suspense fallback={null}>
          <StudioView />
        </Suspense>
      </TooltipProvider>
    );
  }

  if (IS_TRIPO || modalityView === '3d') {
    return (
      <TooltipProvider delayDuration={200}>
        <Suspense fallback={null}>
          <TripoWorkspace />
        </Suspense>
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
          ) : view === 'connectors' ? (
            <ConnectorsScreen onClose={() => setView('chat')} />
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
                contentOverride={
                  view === 'models' ? (
                    <ModelsView />
                  ) : view === 'scheduled' ? (
                    /* Same seam as the model hub: a content route inside the chat
                       shell, so the sidebar and top bar stay put. */
                    <ScheduledView />
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
