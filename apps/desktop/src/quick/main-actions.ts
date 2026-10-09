/**
 * THE MAIN WINDOW'S HALF OF THE QUICK PANEL.
 *
 * The panel hands the main window something to open — its thread as an
 * ordinary chat, a new chat with a draft in it, a studio with a prompt, a
 * Settings section — over `quick:main-action`. The main window may have been
 * closed and made again just for this, so an action waits until the window's
 * own chat has started before it moves anything.
 */
import type { QuickMainAction } from '../../electron/quick/quick-contract';
import { navigate } from '../state/app-nav-store';
import { exitModality, useModalityStore } from '../state/modality-store';
import { newSession, switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { seedStudioDraft } from '../studio/studio-draft';

/** How long an action waits for a freshly made window's chat to start. */
const READY_WAIT_MS = 12_000;

function chatReady(): boolean {
  return usePiStore.getState().session !== null;
}

async function untilChatReady(): Promise<void> {
  const until = Date.now() + READY_WAIT_MS;
  while (!chatReady() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function runQuickMainAction(action: QuickMainAction): Promise<void> {
  switch (action.kind) {
    case 'navigate':
      navigate(action.target);
      return;
    case 'image-studio': {
      seedStudioDraft('image', 'prompt', action.prompt);
      // A room already open read its draft when it mounted: open it afresh.
      if (useModalityStore.getState().view === 'image') {
        exitModality();
        await new Promise((r) => setTimeout(r, 0));
      }
      navigate('studio:image');
      return;
    }
    case 'open-session':
      navigate({ kind: 'chat' });
      await untilChatReady();
      await switchSession(action.file).catch(() => undefined);
      return;
    case 'new-chat':
      navigate({ kind: 'chat' });
      await untilChatReady();
      await newSession().catch(() => undefined);
      if (action.prompt !== undefined) usePiStore.setState({ composerText: action.prompt });
      return;
  }
}

let connected = false;

/** Listen for the panel's hand-offs. Called once, at the main window's boot. */
export function connectQuickMainActions(): void {
  if (connected) return;
  connected = true;
  let chain: Promise<void> = Promise.resolve();
  window.piDesktop.onEvent('quick:main-action', (action) => {
    // One at a time, in the order they came.
    chain = chain.then(() => runQuickMainAction(action)).catch(() => undefined);
  });
}
