/**
 * Devices — main-process handlers for ./devices-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the DEV lane
 * gives the contract its channels (DEV-6). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { DevicesInvokeMap } from './devices-contract';

const handlers: IpcHandlers<DevicesInvokeMap> = {};

export function registerDevicesIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<DevicesInvokeMap>(ipcMain, handlers, { allowSender });
}
