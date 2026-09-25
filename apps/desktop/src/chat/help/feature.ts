/**
 * Bobble help — the renderer side's ONE start-up hook.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). Called
 * once, before the app mounts, by src/features.ts — so lane HELP registers
 * everything it adds to shared surfaces HERE, from its own file, and never
 * edits the surface (R1):
 *   - the + menu's Bobble help row — `registerComposerAction({ id:
 *     'bobble-help' })`, the send routing — `registerSubmitInterceptor`,
 *     and the "Bobble help ×" chip — `registerComposerModeChip`
 *     (chat/composer-entries.ts, BH-7)
 *   - inline settings cards — `registerThreadSlot` (chat/thread-slots.ts,
 *     BH-8)
 *   - guide links — `registerNavHandler('guide', …)`
 *     (state/app-nav-store.ts, BH-3/BH-7)
 *
 * The main-process twin is electron/help/help-main.ts. See
 * deliverables/research/bobble-help.md §4.
 */
export function registerHelpFeature(): void {
  // Nothing yet.
}
