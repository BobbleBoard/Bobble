/**
 * Workflows — the renderer side's ONE start-up hook.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). Called
 * once, before the app mounts, by src/features.ts — so lane WF registers
 * everything it adds to shared surfaces HERE, from its own file, and never
 * edits the surface (R1):
 *   - the Workflows screen — `registerRouteView('workflows', …)`
 *     (route-views.ts, WF-11); its sidebar row then shows itself
 *     (chat/workspace-nav.ts)
 *   - + › Research and Workflows › — `registerComposerAction({ id:
 *     'research' | 'workflows' })`, the no-model-turn dispatch —
 *     `registerSubmitInterceptor` (chat/composer-entries.ts, WF-07/WF-11)
 *   - the run card — `registerThreadSlot` (chat/thread-slots.ts, WF-07)
 *   - "Save as workflow…" — `registerThreadMenuEntry`
 *     (chat/thread-menu-entries.ts, WF-12)
 *
 * The main-process twin is electron/workflows/workflows-main.ts. See
 * deliverables/research/workflows.md §4.
 */
export function registerWorkflowsFeature(): void {
  // Nothing yet.
}
