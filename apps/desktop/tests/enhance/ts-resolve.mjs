/**
 * Extensionless relative imports, resolved to `.ts`.
 *
 * The electron sources are bundled by vite, so they import siblings the way the
 * rest of the codebase does — `./prompt-guidelines`, no extension. Node's own
 * ESM resolver requires the extension, and the fix belongs HERE rather than in
 * the source: making twenty modules carry `.ts` specifiers so one probe can load
 * them would be the test dictating the app's import style.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(`${specifier}.ts`, context);
    } catch {
      /* fall through to the default resolver */
    }
  }
  return next(specifier, context);
}
