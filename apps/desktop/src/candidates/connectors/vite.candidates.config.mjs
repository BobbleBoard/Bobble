/**
 * A renderer-only dev server for LOOKING at the connector candidates.
 *
 * The app's own vite.config.ts is the wrong tool for this twice over: its
 * electronSimple plugin spawns a real Electron window the moment `vite serve`
 * has built main.ts (a window on the user's screen, against his real $HOME — hence
 * `PI_DEV_NO_LAUNCH=1`), and even with the launch suppressed it REBUILDS
 * `dist-electron/` on the way, under the feet of whatever e2e suite is running
 * against the built app. This config serves the SAME renderer (same root, same
 * React + Tailwind plugins) and nothing else; shots.mjs launches its own hidden
 * Electron against it with VITE_DEV_SERVER_URL, and the main process it runs
 * is the one already in dist-electron.
 *
 *   npx vite --config src/candidates/connectors/vite.candidates.config.mjs
 *
 * :5312, so it can sit beside the schedule candidates' server on :5311. The
 * dep-optimizer cache is its own directory under node_modules so a concurrent
 * dev server in the same checkout never fights it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../../..');

export default defineConfig({
  root: APP_ROOT,
  cacheDir:
    process.env.CAND_VITE_CACHE ?? path.join(APP_ROOT, 'node_modules', '.vite-cand-connectors'),
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.CAND_PORT ?? 5312),
    strictPort: true,
    host: '127.0.0.1',
    /*
     * NO HMR. Other sessions edit this checkout while a probe runs, and a full
     * page reload pushed mid-launch is exactly what left a probe "waiting for
     * navigation to finish" (NOTES §28). A screenshot run wants the page it
     * loaded; restart the server to pick up changes.
     */
    hmr: false,
  },
});
