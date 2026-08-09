#!/usr/bin/env node
/**
 * Build the vendored GenOffice main-process seam into a CJS bundle that
 * Bobble's Electron main can require, plus the per-module renderer/preload
 * bundles their views load.
 *
 *   node scripts/build-genoffice.mjs
 *
 * Why esbuild rather than upstream's electron-vite: their config builds five
 * standalone apps, each with its own main entry that has side effects on
 * import. We want one library with none. Their renderers we build with THEIR
 * toolchain, unchanged, because that half is genuinely theirs.
 *
 * The `?asset` loader below is the electron-vite idiom for "give me a path to
 * this file at runtime". esbuild has no concept of it, so we copy the asset
 * next to the bundle and hand back a __dirname-relative path. Without this the
 * slides module cannot bundle at all — HarfBuzz text shaping is imported that
 * way.
 */
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor/genoffice');
const OUT = join(VENDOR, 'embed/out');
const ASSETS = join(OUT, 'assets');

if (!existsSync(join(VENDOR, 'node_modules'))) {
  console.error('build-genoffice: vendor/genoffice/node_modules missing — run `npm install` in vendor/genoffice first');
  process.exit(1);
}

// esbuild belongs to the vendored tree, not to us — this repo is pnpm and the
// vendor is an isolated npm project on purpose, so resolve it explicitly
// rather than adding a root dependency that exists only to build a fork.
const { build } = await import(
  pathToFileURL(join(VENDOR, 'node_modules/esbuild/lib/main.js')).href
);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });

/** electron-vite's `import x from './y.wasm?asset'` → runtime path beside the bundle. */
const assetPlugin = {
  name: 'electron-vite-asset',
  setup(b) {
    b.onResolve({ filter: /\?asset$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?asset$/, '')),
      namespace: 'ev-asset',
    }));
    b.onLoad({ filter: /.*/, namespace: 'ev-asset' }, (args) => {
      const name = basename(args.path);
      cpSync(args.path, join(ASSETS, name));
      return {
        contents: `module.exports = require('node:path').join(__dirname, 'assets', ${JSON.stringify(name)})`,
        loader: 'js',
      };
    });
  },
};

await build({
  entryPoints: [join(VENDOR, 'embed/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(OUT, 'index.cjs'),
  // Electron is provided by the host. Everything else is bundled so the seam
  // does not depend on vendor/genoffice/node_modules existing at runtime.
  external: ['electron'],
  logLevel: 'warning',
  plugins: [assetPlugin],
});

console.log('build-genoffice: seam bundled ->', join(OUT, 'index.cjs'));

// ── the other half: each module's renderer + preload ─────────────────────────
// Built with THEIR toolchain, unmodified. We only consume out/renderer and
// out/preload — out/main is dead weight here, since our seam bundle replaces it.
//
// sheets is built with electron-vite directly rather than `npm run build`,
// because its build script front-runs cargo and we build the sidecar separately
// (it is the one module that needs Rust, and only for xlsx).
const { execFileSync } = await import('node:child_process');
const EVITE = join(VENDOR, 'node_modules/.bin/electron-vite');

for (const mod of ['docs', 'sheets', 'slides', 'pdf', 'markdown']) {
  const cwd = join(VENDOR, 'apps', mod);
  process.stdout.write(`build-genoffice: renderer ${mod} ... `);
  try {
    execFileSync(EVITE, ['build'], { cwd, stdio: 'pipe' });
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    console.error(String(err.stdout ?? err));
    process.exitCode = 1;
  }
}

// A missing renderer is the failure mode that looks like success: the view is
// created, the window is there, and it paints nothing. Assert it instead.
const missing = ['docs', 'sheets', 'slides', 'pdf', 'markdown'].filter(
  (m) =>
    !existsSync(join(VENDOR, 'apps', m, 'out/renderer/index.html')) ||
    !existsSync(join(VENDOR, 'apps', m, 'out/preload/index.js')),
);
if (missing.length) {
  console.error(`build-genoffice: FAIL — no renderer/preload for: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('build-genoffice: all five renderers + preloads present');
