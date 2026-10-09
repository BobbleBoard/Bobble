/**
 * A renderer-only dev server for LOOKING at the schedule candidates.
 *
 * The app's own vite.config.ts is the wrong tool for this: its electronSimple
 * plugin spawns a real Electron window the moment `vite serve` finishes
 * building main.ts — a window on the user's screen, running against their real
 * $HOME. This config serves the SAME renderer (same root, same React + Tailwind
 * plugins) and nothing else; the probe (shots.mjs) launches its own hidden
 * Electron against it with VITE_DEV_SERVER_URL.
 *
 *   npx vite --config src/candidates/schedule/vite.candidates.config.mjs
 *
 * The dep-optimizer cache is kept OUT of the shared node_modules/.vite so a
 * concurrent dev server in the same checkout never fights it.
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
    process.env.CAND_VITE_CACHE ?? path.join(APP_ROOT, 'node_modules', '.vite-cand-schedule'),
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.CAND_PORT ?? 5311),
    strictPort: true,
    host: '127.0.0.1',
    /*
     * NO HMR. Other people edit this checkout while a probe runs, and a full
     * page reload pushed mid-launch is exactly what left a probe "waiting for
     * navigation to finish". A screenshot run wants the page it loaded, not
     * whatever someone saved a second later; restart the server to pick up
     * changes.
     */
    hmr: false,
  },
});
