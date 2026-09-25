/**
 * THE PUSH'S FEATURES, STARTED ONCE — the renderer's twin of the six
 * `register*Ipc` calls in electron/main.ts (the W0-A pre-wire,
 * deliverables/research/PLAN.md §2.3).
 *
 * Each feature registers what it adds to shared surfaces — thread cards, menu
 * rows, top-bar notices, composer modes, route screens — from its own start-up
 * file, and this calls them before the app mounts, so every registry is full
 * at the first paint. The list is lane INT's; the files are their lanes'.
 */
import { registerHelpFeature } from './chat/help/feature';
import { registerDevicesFeature } from './devices/feature';
import { registerEditorFeature } from './editor/feature';
import { registerMemoryFeature } from './memory/feature';
import { registerTrainingFeature } from './training/feature';
import { registerWorkflowsFeature } from './workflows/feature';

let registered = false;

export function registerFeatures(): void {
  if (registered) return;
  registered = true;
  registerMemoryFeature();
  registerHelpFeature();
  registerTrainingFeature();
  registerDevicesFeature();
  registerEditorFeature();
  registerWorkflowsFeature();
}
