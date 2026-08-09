/**
 * Trusted-sender-gated `office:*` channels — the renderer half of
 * office-manager.ts. Split out from the manager so the manager stays a plain
 * module the tests can drive without an ipcMain.
 */
import { createLogger } from '@pi-desktop/shared';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { OfficeBounds, OfficeKind } from './office-contract';
import {
  captureView,
  lastCaptureError,
  createOfficeView,
  destroyView,
  isDirty,
  officeAvailable,
  setBoundsFor,
} from './office-manager';

const log = createLogger('desktop:office');

export function registerOfficeIpc(): void {
  const handle = (
    channel: string,
    handler: (owner: WebContents, req: Record<string, unknown>) => unknown,
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, req) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel });
        throw new Error(`[office] rejected "${channel}": untrusted sender`);
      }
      return handler(event.sender, (req ?? {}) as Record<string, unknown>);
    });
  };

  handle('office:available', () => ({ available: officeAvailable() }));

  handle('office:create', (owner, req) =>
    createOfficeView(req.tabId as string, req.kind as OfficeKind, req.filePath as string, owner),
  );

  handle('office:destroy', (_owner, req) => {
    destroyView(req.tabId as string);
    return { ok: true };
  });

  handle('office:set-bounds', (_owner, req) => {
    setBoundsFor(req.tabId as string, req.bounds as OfficeBounds, req.visible as boolean);
    return { ok: true };
  });

  handle('office:dirty', async (_owner, req) => ({ dirty: await isDirty(req.tabId as string) }));

  handle('office:capture', async (_owner, req) => {
    const dataUrl = await captureView(req.tabId as string);
    return { dataUrl, error: dataUrl === null ? lastCaptureError : null };
  });
}
