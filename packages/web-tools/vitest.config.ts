import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The env-guarded integration test hits the live web and bootstraps uv +
    // a managed Python interpreter (first run downloads both), so give it room.
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    env: {
      // Tests never touch the app's real download cache (~/.cache/bobble): a uv
      // install that is not given a `dir` lands here instead. Set it yourself to
      // point a run elsewhere.
      PI_DESKTOP_CACHE_DIR:
        process.env.PI_DESKTOP_CACHE_DIR ?? join(tmpdir(), 'pi-web-tools-test-cache'),
    },
  },
});
