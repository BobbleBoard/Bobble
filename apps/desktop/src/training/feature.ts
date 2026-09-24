/**
 * Training — the renderer side's ONE start-up hook.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). Called
 * once, before the app mounts, by src/features.ts — so lane TRAIN registers
 * everything it adds to shared surfaces HERE, from its own file, and never
 * edits the surface (R1):
 *   - the Training screen — `registerRouteView('training', …)`
 *     (route-views.ts, TR-5); its sidebar row then shows itself once
 *     `capabilities.training` is on (chat/workspace-nav.ts)
 *   - the top-bar chip — `registerTopBarNotice` (chat/topbar-notices.ts,
 *     TR-6)
 *
 * The main-process twin is electron/training/training-main.ts. See
 * deliverables/research/training.md §4.11.
 */
export function registerTrainingFeature(): void {
  // Nothing yet.
}
