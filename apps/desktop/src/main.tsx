import { installFocusRingTracking } from '@pi-desktop/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { completeSoftReload, onSoftReload, reloadGeneration, softReload } from './app-reload';
import { CrashSeam } from './crash-seam';
import { registerFeatures } from './features';
import { connectQuickMainActions } from './quick/main-actions';
import { connectChatJobs } from './state/chat-jobs';
import { connectChildAgents } from './state/child-agent-store';
import { connectGen } from './state/gen-store';
import { connectHf } from './state/hf-store';
import { startIdleReturnWatch } from './state/idle-return';
import { connectLlm, ensureDefaultEngines } from './state/llm-store';
import { connectPi } from './state/pi-connect';
import { connectSettings } from './state/settings-store';
import { connectStoreModels } from './state/store-models';
import { connectStudioJobs } from './state/studio-jobs';
import { connectTaskTray } from './state/task-tray';
import { connectLoadTimer } from './state/tray-transfers';
import './styles/global.css';

/*
 * Focus-ring modality, before React mounts so the very first paint is already
 * correct. See @pi-desktop/ui focus-ring.ts: `:focus-visible` alone lights up
 * on Escape-dismissal and on window refocus, which is what the user kept seeing as
 * a blue box around controls the user had only clicked.
 */
installFocusRingTracking();

/*
 * THE QUICK PANEL'S WINDOW (`?quickPanel=1`, electron/quick/quick-main.ts): its
 * own pi session, the model's status and the settings — and none of the main
 * window's sidebar, studios or scheduled tasks.
 */
const IS_QUICK_PANEL = new URLSearchParams(window.location.search).has('quickPanel');
if (IS_QUICK_PANEL) {
  document.documentElement.classList.add('qp-root');
  connectPi();
  connectLlm();
  connectStoreModels();
  connectSettings();
}

// Attach the pi + inference event streams before React mounts so nothing
// buffered (pre-mount events) is lost, and load settings (theme is applied from
// them). The standalone canvas pop-out window (?canvasPopout=1) mounts only the
// canvas, so it needs none of these.
if (!IS_QUICK_PANEL && !new URLSearchParams(window.location.search).has('canvasPopout')) {
  connectPi();
  connectChildAgents();
  // Which chat started which generation — a deleted chat's jobs are stopped.
  connectChatJobs();
  // A studio's job is followed here, not in the room — leaving the room must
  // not lose it (state/studio-jobs.ts).
  connectStudioJobs();
  // The tasks you walked away from, for the button beside the sidebar toggle.
  connectTaskTray();
  connectLlm();
  // A model back from an idle unload gets its prompt warm again (state/idle-return.ts).
  startIdleReturnWatch();
  // How long each model took to load here — the tray's Loading bar walks at it.
  connectLoadTimer();
  // The default engines for this machine, in the background (see llm-store).
  setTimeout(() => void ensureDefaultEngines(), 8_000);
  connectHf();
  connectGen();
  connectStoreModels();
  connectSettings();
  // What the push's features add to shared surfaces, before the first paint
  // (src/features.ts). Nothing yet.
  registerFeatures();
  // The main window's half of the quick panel: "Open in Bobble" and friends.
  connectQuickMainActions();
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html is missing the #root element');
}

/**
 * The mount point of the whole app, and the one thing that can RE-mount it.
 *
 * `generation` keys the boundary and the app together, so bumping it (⌘R, or
 * the crash card's Reload) unmounts everything — clearing a caught error along
 * with whatever render state caused it — and mounts a fresh tree, while the
 * stores, the pi session and the chat on disk carry straight on. See
 * app-reload.ts for what is held across the swap and put back afterwards.
 */
function AppRoot() {
  const [generation, setGeneration] = useState(reloadGeneration);
  useEffect(() => onSoftReload(setGeneration), []);
  /*
   * ⌘R, wired HERE rather than in ChatApp with ⌘W: a reload has to work on
   * every route — a studio, the model hub, the canvas pop-out, and above all
   * the crash card, none of which have a ChatApp under them.
   */
  useEffect(
    () =>
      window.piDesktop.onEvent('app:accelerator', ({ action }) => {
        if (action === 'soft-reload') softReload();
      }),
    [],
  );
  // After the fresh tree has mounted: the canvas tabs and the scroll position.
  useEffect(() => {
    if (generation > 0) completeSoftReload();
  }, [generation]);
  return (
    /* A render throw unmounts the whole tree and leaves a blank window (the user:
       "total blank screen"). This is the only thing that can catch it. */
    <AppErrorBoundary key={generation}>
      {/* Renders nothing; `?piE2E=1` + window.__pi_crash() makes it throw, so
          the crash card and its recovery can be driven by a probe. */}
      <CrashSeam />
      <App />
    </AppErrorBoundary>
  );
}

if (IS_QUICK_PANEL) {
  // Its own chunk, so the main window never loads the panel's code or styles.
  void import('./quick/QuickPanelApp').then(({ QuickPanelApp }) => {
    createRoot(rootElement).render(
      <StrictMode>
        <AppErrorBoundary>
          <QuickPanelApp />
        </AppErrorBoundary>
      </StrictMode>,
    );
  });
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}
