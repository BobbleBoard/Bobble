/**
 * Let a probe import workspace TypeScript SOURCE directly.
 *
 * Node (the repo requires ≥ 24) strips types on its own, so
 * `import('../../../../packages/web-tools/src/search.ts')` already works. What
 * it will not do is follow the `./tailscale.js` specifiers that TS source
 * written for `moduleResolution: nodenext` uses to the `./tailscale.ts` file
 * that is actually on disk. This registers exactly that mapping — a relative
 * `.js` import from a `.ts` file that does not exist falls back to `.ts` — and
 * nothing else.
 *
 * Linking happens before evaluation, so import this first and bring the TS
 * module in with a DYNAMIC import:
 *
 *   import './_ts-source.mjs';
 *   const { readTailnet } = await import('../../../../packages/cluster/src/host.ts');
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const fromTs = context.parentURL?.endsWith('.ts') === true;
      if (
        err?.code === 'ERR_MODULE_NOT_FOUND' &&
        fromTs &&
        /^\.\.?\//.test(specifier) &&
        specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
