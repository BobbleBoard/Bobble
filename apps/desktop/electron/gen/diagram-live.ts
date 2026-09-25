/**
 * THE DIAGRAM WHILE IT IS TYPED — main's half of the live diagram card.
 *
 * the user (2026-09-25): "ensure those animate/build in real time smoothly". A
 * `diagram` call is Mermaid the model types out line by line; the thread
 * (chat/PendingDiagramCard) asks here for a frame each time a whole new line
 * has arrived, at most every ~200 ms, and animates from one frame to the
 * next. The frame is drawn exactly the way the tool's own drawing is — the
 * same page and post-pass, the same kit resolution, the same roles
 * (diagram-page.ts runDiagramLive) — so the frame for the last line IS the
 * card the tool is about to present, and the hand-over moves nothing.
 *
 * ONE hidden window, kept while frames keep coming: a fresh window per frame
 * (the final render's way, diagram-render.ts) costs Mermaid's 3 MB load every
 * time. It goes after IDLE_MS without a frame, and at once when the app
 * window it serves goes — a window left behind would count as the app's own
 * when the dock asks whether one is open (diagram-render.ts).
 *
 * LATEST WINS, per call: frames are drawn one at a time, and a frame still
 * waiting when a newer one for the same call arrives is answered `superseded`
 * without being drawn — the card only ever wants the newest.
 */
import { readFile } from 'node:fs/promises';
import { diagramTheme, type Kit, kitById, loadProjectKit } from '@pi-desktop/design-kit';
import { createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { designKitEnv } from '../settings/features/design-settings';
import { readSettings } from '../settings/settings-main';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { DiagramLiveReply, DiagramLiveRequest } from './diagram-contract';
import { checkLiveRequest, createLiveQueue } from './diagram-live-queue';
import { type DiagramPage, diagramId, runDiagramLive } from './diagram-page';
import { openDiagramWindow } from './diagram-render';

const log = createLogger('desktop:diagram-live');

/** The window goes this long after the last frame. */
const IDLE_MS = 5_000;
/** A frame that takes longer is a graph Mermaid is stuck on: the window is replaced. */
const FRAME_TIMEOUT_MS = 8_000;

// ── the window ──────────────────────────────────────────────────────────────

let opened: Promise<{ page: DiagramPage; dispose: () => void }> | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
const watched = new WeakSet<WebContents>();

function closeWindow(): void {
  if (idle !== undefined) clearTimeout(idle);
  idle = undefined;
  const was = opened;
  opened = null;
  void was?.then((w) => w.dispose()).catch(() => undefined);
}

/** The window, opened if it is not; its idle clock stops while a frame is drawn. */
function windowFor(): Promise<{ page: DiagramPage; dispose: () => void }> {
  if (idle !== undefined) clearTimeout(idle);
  idle = undefined;
  opened ??= openDiagramWindow().catch((err: unknown) => {
    opened = null;
    throw err;
  });
  return opened;
}

/** A frame is done: the window goes IDLE_MS from now unless another one comes. */
function idleFromNow(): void {
  if (opened === null) return;
  if (idle !== undefined) clearTimeout(idle);
  idle = setTimeout(closeWindow, IDLE_MS);
}

/** The kit a call's diagram wears — the tool's own order (diagram-tool.ts kitFor). */
async function kitFor(named: string | undefined, root: string | undefined): Promise<Kit> {
  if (named !== undefined && named.trim() !== '') {
    const kit = kitById(named);
    if (kit !== undefined) return kit;
  }
  const project = await loadProjectKit({
    ...(root !== undefined && root !== '' ? { root } : {}),
    kitName: designKitEnv(readSettings().design),
    readFile: (f) => readFile(f, 'utf8'),
  });
  return project.kit;
}

async function drawFrame(req: DiagramLiveRequest): Promise<DiagramLiveReply> {
  const kit = await kitFor(req.kit, req.root);
  const look = req.look ?? kit.diagram.look;
  const theme = { ...diagramTheme(kit, req.mode), look };
  const win = await windowFor();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      runDiagramLive(win.page, {
        id: `${diagramId(`live\n${req.id}`)}${req.mode === 'light' ? 'l' : 'd'}`,
        source: req.source,
        theme,
        partial: req.partial === true,
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.subtitle !== undefined ? { subtitle: req.subtitle } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the frame took too long')), FRAME_TIMEOUT_MS);
      }),
    ]);
    if (!reply.ok) return reply;
    return { ...reply, kit: kit.id, paper: kit[req.mode].paper };
  } catch (err) {
    // A window that threw or hung is not reused: the next frame opens a fresh one.
    closeWindow();
    const message = err instanceof Error ? err.message : String(err);
    log.warn('live frame failed', { message });
    return { ok: false, error: message, line: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    idleFromNow();
  }
}

const drawLive = createLiveQueue(drawFrame);

/** `diagram:live` — a trusted window's next frame. */
export function registerDiagramLiveIpc(): void {
  ipcMain.handle('diagram:live', async (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error('[diagram] rejected "diagram:live": untrusted sender');
    }
    const req = checkLiveRequest(raw);
    if (req === null)
      return { ok: false, error: 'a live frame needs an id, a source and a mode', line: null };
    // The window serves this app window; it goes when that one does.
    if (!watched.has(event.sender)) {
      watched.add(event.sender);
      event.sender.once('destroyed', closeWindow);
    }
    return drawLive(req);
  });
}
