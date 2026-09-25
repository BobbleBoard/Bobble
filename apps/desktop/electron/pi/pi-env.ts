/**
 * WHAT A FEATURE PUTS ON EVERY PI CHILD'S ENVIRONMENT, from its own file.
 *
 * `buildPiEnv` (pi-main.ts) is the one place a pi child's environment is made,
 * and it is a hot file: memory wants `PI_DESKTOP_MEMORY_FILE` there (WP-M6),
 * the cross-platform shell wants its bash (XP-13), and more will follow. Each
 * registers a contributor instead of editing it
 * (deliverables/research/PLAN.md §2.3, R1).
 *
 * The order is fixed and it is the rule: the inherited environment, then every
 * contributor, then the app's own keys. So a contributor can supply or replace
 * anything the app merely inherited (a PATH, a SHELL), and can never change a
 * key the app itself sets — the file fence, the tool interface, the vision
 * flag stay exactly what pi-main decided. Contributors run on every spawn
 * (the main chat, a child, a scheduled run, a scoped pi), so a value read from
 * a live setting is fresh each time.
 *
 * Electron-free: pure composition, unit-tested.
 */

export interface PiEnvContext {
  /** The spawn's working folder, when there is one. */
  readonly cwd: string | undefined;
}

export type PiEnvContributor = (
  ctx: PiEnvContext,
) => Record<string, string | undefined> | undefined;

const contributors = new Set<PiEnvContributor>();

/** Add a contributor; the returned function removes it. */
export function registerPiEnvContributor(contributor: PiEnvContributor): () => void {
  contributors.add(contributor);
  return () => {
    contributors.delete(contributor);
  };
}

/**
 * Every contributor's keys, in registration order (a later one wins over an
 * earlier one). A contributor that throws is skipped and reported — a broken
 * feature must not stop a chat from starting.
 */
export function piEnvContributions(
  ctx: PiEnvContext,
  onError?: (error: unknown) => void,
): Record<string, string | undefined> {
  if (contributors.size === 0) return {};
  const out: Record<string, string | undefined> = {};
  for (const contribute of contributors) {
    try {
      Object.assign(out, contribute(ctx) ?? {});
    } catch (error) {
      onError?.(error);
    }
  }
  return out;
}

/** Test seam. */
export function resetPiEnvContributorsForTests(): void {
  contributors.clear();
}
