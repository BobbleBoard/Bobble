/**
 * Resolve `./x.js` to `./x.ts` when only the TypeScript file exists.
 *
 * This repo's packages import each other with the `.js` extension the TypeScript
 * compiler expects to emit, while the files on disk are `.ts`. Node 26 strips
 * types natively but does not rewrite specifiers, so a plain script importing a
 * package source hits ERR_MODULE_NOT_FOUND on the first hop.
 *
 * Used only by evaluation scripts, so they can measure the REAL modules instead
 * of a transcribed copy of them.
 */
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    try {
      return await next(specifier, context);
    } catch (err) {
      try {
        return await next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw err;
      }
    }
  }
  return next(specifier, context);
}
