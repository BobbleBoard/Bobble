/**
 * Workflows — main-process handlers for ./workflows-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the WF lane
 * gives the contract its channels (WF-02). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { WorkflowsInvokeMap } from './workflows-contract';

const handlers: IpcHandlers<WorkflowsInvokeMap> = {};

export function registerWorkflowsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<WorkflowsInvokeMap>(ipcMain, handlers, { allowSender });
}
