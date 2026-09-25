/**
 * Memory — the renderer side's ONE start-up hook.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). Called
 * once, before the app mounts, by src/features.ts — so lane MEM registers
 * everything it adds to shared surfaces HERE, from its own file, and never
 * edits the surface (R1):
 *   - the "Remembered N things" chip — `registerThreadSlot`
 *     (chat/thread-slots.ts, WP-M8)
 *   - "Forget what Bobble learned here" — `registerThreadMenuEntry`, and
 *     the "also forget" box — `registerDeleteChatOption`
 *     (chat/thread-menu-entries.ts, WP-M8)
 *   - Temporary chat — `registerComposerAction({ id: 'temporary-chat' })`
 *     (chat/composer-entries.ts, WP-M8)
 *   - the Memory storage row lives main-side
 *     (electron/storage/storage-rows.ts, WP-M9)
 *
 * The main-process twin is electron/memory/memory-main.ts. See
 * deliverables/research/hindsight-memory.md §4.
 */
export function registerMemoryFeature(): void {
  // Nothing yet.
}
