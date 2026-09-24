/**
 * Editor — main-process handlers for ./editor-contract.ts.
 *
 * SKELETON from the W0-A pre-wire: registered from main.ts's registerAppIpc
 * (sender-gated like every other app channel) and a no-op until the EDIT lane
 * gives the contract its channels (ED-01). Handlers go in the map below; the
 * type makes a missing one a compile error.
 */
import { type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { EditorInvokeMap } from './editor-contract';

const handlers: IpcHandlers<EditorInvokeMap> = {};

export function registerEditorIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<EditorInvokeMap>(ipcMain, handlers, { allowSender });
}
