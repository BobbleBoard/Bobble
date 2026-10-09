/**
 * WHAT THE QUICK PANEL DOES — every action its buttons, keys and palette run.
 *
 * The panel's window is one more renderer of the app (main.tsx mounts
 * QuickPanelApp under `?quickPanel=1`). Its conversation is an ordinary pi
 * session of its own, driven by the same `sendPrompt` the chat uses — so a
 * model that is not loaded yet, an image that needs a model that can see, a
 * model that will not start: all of it behaves exactly as it does in a chat.
 * The thread is saved like any chat, which is what lets "Open in Bobble" open
 * it in the main window as a normal one.
 *
 * Main tells the panel when it is summoned (with what was in front and its
 * selected text, read before the panel took the keyboard) and when it is put
 * away; everything else is asked of main through the `quick:*` channels.
 */
import {
  assembleQuickMessage,
  type QuickContext,
  type QuickTextAction,
  replacementText,
} from '../../electron/quick/context';
import type { PanelSize } from '../../electron/quick/placement';
import type { QuickMainAction, QuickResult } from '../../electron/quick/quick-contract';
import { buildAgentMessage } from '../chat/composer/agent-message';
import { newSession, sendPrompt, startPi, switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useSettingsStore } from '../state/settings-store';
import { computerUseGate } from './computer-use-gate';
import { markInputActivity } from './input-activity';
import type { ProblemFix } from './quick-problem';
import { FRESH_THREAD_AFTER_MS, useQuickStore } from './quick-store';
import { threadTitle } from './thread-model';

let piStarted: Promise<unknown> | null = null;

/** Start the panel's own pi once — on the first summon, so the first question is not kept waiting. */
function ensurePi(): Promise<unknown> {
  piStarted ??= startPi({}).catch(() => {
    piStarted = null;
  });
  return piStarted;
}

function invoke<K extends Parameters<typeof window.piDesktop.invoke>[0]>(
  channel: K,
  request: Parameters<typeof window.piDesktop.invoke<K>>[1],
) {
  return window.piDesktop.invoke(channel, request);
}

let lastSize: PanelSize = 'compact';
let lastHeight = 0;

/** Ask main for a size. Compact also says how tall its content is, so the panel hugs it. */
export function requestSize(size: PanelSize, height?: number): void {
  const h = height === undefined ? undefined : Math.round(height);
  if (size === lastSize && (h === undefined || Math.abs(h - lastHeight) < 2)) return;
  lastSize = size;
  if (h !== undefined) lastHeight = h;
  useQuickStore.getState().set({ size });
  void invoke('quick:resize', h === undefined ? { size } : { size, height: h }).catch(
    () => undefined,
  );
}

export function dismiss(): void {
  void invoke('quick:dismiss', { reason: 'escape' }).catch(() => undefined);
}

/** A fresh thread in the panel; the old one stays a chat in the sidebar and in Recent. */
export async function newThread(): Promise<void> {
  const q = useQuickStore.getState();
  q.set({
    text: '',
    contexts: [],
    attachments: [],
    problem: null,
    note: null,
    view: 'home',
    turnMeta: {},
  });
  if (usePiStore.getState().messages.length > 0) await newSession().catch(() => undefined);
  requestSize('compact');
}

/** Continue a thread from the panel's history. */
export async function openThread(file: string): Promise<void> {
  useQuickStore.getState().set({ view: 'home', contexts: [], attachments: [], problem: null });
  await ensurePi();
  await switchSession(file).catch(() => undefined);
  requestSize('expanded');
}

function applyCapture(result: QuickResult, retry: () => void): void {
  const q = useQuickStore.getState();
  if (result.ok) {
    q.addContext(result.context);
    q.set({ note: result.note ?? null });
  } else if (result.problem !== undefined) {
    q.showProblem(result.problem, retry);
  }
}

/** Attach a picture: the window in front, a window from the picker, the screen, an area, or a window clicked on screen. */
export async function captureInto(
  kind: 'front-window' | 'window' | 'screen' | 'region' | 'pick',
  windowId?: number,
): Promise<void> {
  markInputActivity('capture');
  useQuickStore.getState().set({ view: 'home', problem: null });
  const result = await invoke(
    'quick:capture',
    windowId === undefined ? { kind } : { kind, windowId },
  ).catch((): QuickResult => ({ ok: false, problem: { kind: 'failed' } }));
  applyCapture(result, () => void captureInto(kind, windowId));
}

/** Read the selection again, the clipboard, Finder's selection, or the browser's page. */
export async function readInto(
  kind: 'selection' | 'clipboard' | 'finder' | 'browser',
): Promise<void> {
  if (kind === 'clipboard') markInputActivity('paste');
  useQuickStore.getState().set({ problem: null });
  const result = await invoke('quick:read', { kind }).catch(
    (): QuickResult => ({ ok: false, problem: { kind: 'failed' } }),
  );
  applyCapture(result, () => void readInto(kind));
}

/** Act in the app that was in front: computer use on its pid, gated by Settings. */
export function attachFrontApp(): boolean {
  const q = useQuickStore.getState();
  const front = q.front;
  if (front === null || front.isBobble === true) return false;
  q.addContext({
    kind: 'app',
    id: `app-${front.pid}`,
    app: front.name,
    pid: front.pid,
    ...(front.bundleId !== undefined ? { bundleId: front.bundleId } : {}),
  });
  return true;
}

/** The gate, said in the panel before a turn starts that could only be refused. */
function gateFor(contexts: readonly QuickContext[]): boolean {
  const app = contexts.find((c): c is Extract<QuickContext, { kind: 'app' }> => c.kind === 'app');
  if (app === undefined) return true;
  const policy = useSettingsStore.getState().settings.computerUse;
  const gate = computerUseGate(policy, {
    name: app.app,
    ...(app.bundleId !== undefined ? { bundleId: app.bundleId } : {}),
  });
  if (gate === 'off') {
    useQuickStore.getState().showProblem({ kind: 'computer-use-off', app: app.app });
    return false;
  }
  if (gate === 'never') {
    useQuickStore.getState().showProblem({ kind: 'computer-use-never', app: app.app });
    return false;
  }
  return true;
}

/**
 * Send what is in the panel. Returns false when there was nothing to send (or
 * a gate said no, which leaves a card saying why).
 */
export async function sendFromPanel(text: string, action?: QuickTextAction): Promise<boolean> {
  const q = useQuickStore.getState();
  const assembled = assembleQuickMessage({
    text,
    contexts: q.contexts,
    ...(action !== undefined ? { action } : {}),
    language: q.language,
  });
  const attachments = q.attachments;
  if (assembled === null && attachments.length === 0) return false;
  if (!gateFor(q.contexts)) return false;
  const display = assembled?.display ?? (text.trim() !== '' ? text.trim() : 'Have a look at this');
  const base = assembled?.agentMessage ?? display;
  const agentMessage = attachments.length > 0 ? buildAgentMessage(base, attachments) : base;
  const images = [
    ...(assembled?.images ?? []),
    ...attachments.flatMap((a) => (a.image !== undefined ? [a.image] : [])),
  ];
  const selection = q.contexts.find((c) => c.kind === 'selection');
  // The app chip stays: a follow-up is still "in that app".
  q.set({
    contexts: q.contexts.filter((c) => c.kind === 'app'),
    attachments: [],
    problem: null,
    note: null,
    view: 'home',
    lastActivity: Date.now(),
  });
  requestSize(q.size === 'large' ? 'large' : 'expanded');
  await ensurePi();
  const sending = sendPrompt(display, images, agentMessage === display ? undefined : agentMessage);
  // The echo is appended before sendPrompt's first await: this is its id.
  const echoId = usePiStore.getState().messages.at(-1)?.id;
  if (echoId !== undefined) {
    q.set({
      turnMeta: {
        ...useQuickStore.getState().turnMeta,
        [echoId]: {
          replaces: assembled?.replacesSelection === true,
          editableSelection: selection?.kind === 'selection' && selection.editable,
          ...(selection?.kind === 'selection' ? { app: selection.app } : {}),
        },
      },
    });
  }
  try {
    await sending;
  } catch {
    /* sendPrompt holds a failed send under its bubble with a card that says why */
  }
  void rememberThread();
  return true;
}

/** Put the panel's thread in its history, once pi has named the file. */
async function rememberThread(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const file = usePiStore.getState().session?.sessionFile;
    if (file !== undefined && file !== '') {
      await invoke('quick:remember-thread', {
        file,
        title: threadTitle(usePiStore.getState().messages),
        at: Date.now(),
      }).catch(() => undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Hand something to the main window (making it again if it was closed). */
export function openInMain(action: QuickMainAction): void {
  void invoke('quick:open-in-main', { action }).catch(() => undefined);
}

/** "Open in Bobble": this thread as an ordinary chat in the main window; the panel starts fresh. */
export async function openThreadInBobble(draft: string): Promise<void> {
  const file = usePiStore.getState().session?.sessionFile;
  const hasThread = usePiStore.getState().messages.length > 0;
  if (hasThread && file !== undefined && file !== '') {
    openInMain({ kind: 'open-session', file });
    // Two pis must not write one session: the panel moves on to a new one.
    await newThread();
    return;
  }
  openInMain({ kind: 'new-chat', ...(draft.trim() !== '' ? { prompt: draft.trim() } : {}) });
}

export async function copyText(text: string): Promise<void> {
  await invoke('quick:copy', { text }).catch(() => undefined);
}

/** Put a reply where the selection was. */
export async function replaceSelectionWith(reply: string): Promise<void> {
  const res = await invoke('quick:replace-selection', { text: replacementText(reply) }).catch(
    () => ({ ok: false, problem: { kind: 'failed' as const } }),
  );
  if (!res.ok && res.problem !== undefined) {
    useQuickStore.getState().showProblem(res.problem, () => void replaceSelectionWith(reply));
  }
}

export async function runFix(fix: ProblemFix): Promise<void> {
  const q = useQuickStore.getState();
  switch (fix.kind) {
    case 'system-settings':
      await invoke('quick:open-system-settings', { pane: fix.pane }).catch(() => undefined);
      return;
    case 'turn-on-computer-use': {
      const cu = useSettingsStore.getState().settings.computerUse;
      await useSettingsStore.getState().update({ computerUse: { ...cu, enabled: true } });
      q.showProblem(null);
      return;
    }
    case 'open-settings':
      openInMain({ kind: 'navigate', target: `settings:${fix.section}` });
      return;
    case 'retry': {
      const retry = q.retry;
      q.showProblem(null);
      retry?.();
      return;
    }
  }
}

/** Wire the panel to main's events. Called once, at the panel window's boot. */
export function connectQuickPanel(): () => void {
  const offs: Array<() => void> = [];
  offs.push(
    window.piDesktop.onEvent('quick:summoned', (ev) => {
      const q = useQuickStore.getState();
      void useSettingsStore
        .getState()
        .load()
        .catch(() => undefined);
      // Back after a long while: the old thread stays in Recent, this one starts clean.
      const stale =
        q.lastActivity > 0 &&
        Date.now() - q.lastActivity > FRESH_THREAD_AFTER_MS &&
        usePiStore.getState().messages.length > 0;
      if (stale) void newThread();
      const frontChanged = q.front?.pid !== ev.front?.pid;
      q.set({
        shown: true,
        summons: q.summons + 1,
        front: ev.front,
        view: 'home',
        problem: null,
        note: null,
        contexts: q.contexts.filter((c) => {
          // A different app in front: its chips from last time do not belong here.
          if (frontChanged && (c.kind === 'app' || c.kind === 'browser')) return false;
          // A selection is what was selected at the moment of opening — this
          // opening's, or none (a password field, nothing selected).
          if (!q.shown && c.kind === 'selection') return false;
          return true;
        }),
      });
      if (ev.selection !== null) useQuickStore.getState().addContext(ev.selection);
      if (ev.selectionProblem !== undefined)
        useQuickStore.getState().showProblem(ev.selectionProblem);
      if (ev.capture !== undefined) {
        const action = ev.action;
        applyCapture(
          ev.capture,
          () =>
            void captureInto(
              action === 'region' ? 'region' : action === 'window' ? 'front-window' : 'screen',
            ),
        );
      }
      if (ev.action === 'dictate') {
        markInputActivity('talk');
        useQuickStore.getState().set({ talkRequests: useQuickStore.getState().talkRequests + 1 });
      }
      void ensurePi();
    }),
  );
  offs.push(
    window.piDesktop.onEvent('quick:hidden', () => {
      useQuickStore.getState().set({ shown: false, view: 'home', capturing: null });
    }),
  );
  offs.push(
    window.piDesktop.onEvent('quick:capturing', (ev) => {
      useQuickStore.getState().set({ capturing: ev.active ? ev.kind : null });
    }),
  );
  // ⌘W in the panel puts it away, as Esc does.
  offs.push(
    window.piDesktop.onEvent('app:accelerator', ({ action }) => {
      if (action === 'close-tab') dismiss();
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
