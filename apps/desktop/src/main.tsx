import { installFocusRingTracking } from '@pi-desktop/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { connectChildAgents } from './state/child-agent-store';
import { connectGen } from './state/gen-store';
import { connectHf } from './state/hf-store';
import { connectLlm } from './state/llm-store';
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
  connectLlm();
  connectHf();
  connectGen();
  connectStoreModels();
  connectSettings();
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html is missing the #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    {/* A render throw unmounts the whole tree and leaves a blank window (the user:
        "total blank screen"). This is the only thing that can catch it. */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
