/**
 * Help — main-process handlers for ./help-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the HELP lane
 * gives the contract its channels (BH-4). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { HelpInvokeMap } from './help-contract';

const handlers: IpcHandlers<HelpInvokeMap> = {};

export function registerHelpIpc(ipcMain: IpcMain, allowSender: (event: unknown) => boolean): void {
  registerIpcHandlers<HelpInvokeMap>(ipcMain, handlers, { allowSender });
}
