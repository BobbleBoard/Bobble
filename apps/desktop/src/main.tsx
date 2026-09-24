import { installFocusRingTracking } from '@pi-desktop/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { completeSoftReload, onSoftReload, reloadGeneration, softReload } from './app-reload';
import { CrashSeam } from './crash-seam';
import { registerFeatures } from './features';
import { connectChatJobs } from './state/chat-jobs';
import { connectChildAgents } from './state/child-agent-store';
import { connectGen } from './state/gen-store';
import { connectHf } from './state/hf-store';
import { connectLlm, ensureDefaultEngines } from './state/llm-store';
import { connectPi } from './state/pi-connect';
import { connectSettings } from './state/settings-store';
import { connectStoreModels } from './state/store-models';
import './styles/global.css';

/*
 * Focus-ring modality, before React mounts so the very first paint is already
 * correct. See @pi-desktop/ui focus-ring.ts: `:focus-visible` alone lights up
 * on Escape-dismissal and on window refocus, which is what the user kept seeing as
 * a blue box around controls he had only clicked.
 */
installFocusRingTracking();

// Attach the pi + inference event streams before React mounts so nothing
// buffered (pre-mount events) is lost, and load settings (theme is applied from
// them). The standalone canvas pop-out window (?canvasPopout=1) mounts only the
// canvas, so it needs none of these.
if (!new URLSearchParams(window.location.search).has('canvasPopout')) {
  connectPi();
  connectChildAgents();
  // Which chat started which generation — a deleted chat's jobs are stopped.
  connectChatJobs();
  connectLlm();
  // The default engines for this machine, in the background (see llm-store).
  setTimeout(() => void ensureDefaultEngines(), 8_000);
  connectHf();
  connectGen();
  connectStoreModels();
  connectSettings();
  // What the push's features add to shared surfaces, before the first paint
  // (src/features.ts). Nothing yet.
  registerFeatures();
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

createRoot(rootElement).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
