import { defineConfig } from 'vitest/config';

// Standalone config: vitest must not load vite.config.ts, which would start
// the Electron plugin during unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    // electron/ tests cover electron-free seam modules only (structural
    // injection); nothing there may import the real `electron`.
    /* `tests/e2e` holds the PROBE HARNESS, whose pure rules deserve unit tests
       of their own — the focus guard in particular, which cannot be exercised
       for real without doing the very thing it exists to prevent. Only `.test.ts`
       matches, so the `.mjs` probes are not swept in. */
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts', 'tests/**/*.test.ts'],
    // The library root and cache root pinned to scratch — see the guard.
    setupFiles: ['../../packages/shared/vitest.library-guard.ts'],
  },
});
