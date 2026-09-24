/**
 * Training — main-process handlers for ./training-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the TRAIN lane
 * gives the contract its channels (TR-4). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { TrainingInvokeMap } from './training-contract';

const handlers: IpcHandlers<TrainingInvokeMap> = {};

export function registerTrainingIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<TrainingInvokeMap>(ipcMain, handlers, { allowSender });
}
