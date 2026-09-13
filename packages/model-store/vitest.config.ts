import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure Node: layout maths, manifest round-trips, and the repo downloader
    // driven by an injected fetch. Nothing here touches the network or the
    // user's real cache — every test passes its own root.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['../shared/vitest.library-guard.ts'],
  },
});
