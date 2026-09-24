/**
 * Memory — main-process handlers for ./memory-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the MEM lane
 * gives the contract its channels (WP-M3b and WP-M7). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { MemoryInvokeMap } from './memory-contract';

const handlers: IpcHandlers<MemoryInvokeMap> = {};

export function registerMemoryIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<MemoryInvokeMap>(ipcMain, handlers, { allowSender });
}
