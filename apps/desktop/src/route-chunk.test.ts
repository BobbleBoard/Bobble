/**
 * The route-failure policy: what counts as "this route's code is missing", how
 * many retries a panel may offer before it has to stop, and which of the two
 * EXISTING recoveries it hands over to.
 *
 * These are the rules the screenshots cannot check — a probe can show one panel
 * on one route; this pins the wording and the bounds for all of them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  armChunkFailure,
  bustedChunkUrl,
  chunkUrlFromError,
  errorMessage,
  isChunkLoadError,
  loadRouteChunk,
  MAX_ROUTE_RETRIES,
  routePanel,
  takeArmedFailure,
} from './route-chunk';

describe('isChunkLoadError', () => {
  it('recognises the failure the user actually hit', () => {
    // Copied from the crash card in the reproduction, not invented.
    const real = new Error(
      'Failed to fetch dynamically imported module: file:///Users/user/Desktop/OSS-harness/apps/desktop/dist/assets/ImageStudio-CPT1vDU_.js',
    );
    expect(isChunkLoadError(real)).toBe(true);
  });

  it('recognises the other phrasings a browser or the bundler uses', () => {
    for (const message of [
      'error loading dynamically imported module: /assets/VideoStudio-abc.js',
      'Importing a module script failed.',
      'Failed to load module script: MIME type text/html',
      'Unable to preload CSS for /assets/TripoWorkspace-x.css',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
    const named = Object.assign(new Error('boom'), { name: 'ChunkLoadError' });
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('does not mistake an ordinary render bug for a missing file', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new Error('Minified React error #185'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('errorMessage', () => {
  it('survives whatever a boundary is handed', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope');
    expect(errorMessage('a string throw')).toBe('a string throw');
    expect(errorMessage(new Error(''))).toContain('Error');
    expect(errorMessage({ weird: true })).toBe('[object Object]');
  });
});

describe('routePanel', () => {
  const chunk = new Error('Failed to fetch dynamically imported module: ImageStudio-x.js');
  const bug = new Error('Cannot read properties of undefined');

  it('offers a retry on the first failure, and names the route', () => {
    const panel = routePanel({ label: 'Image studio', error: chunk, attempts: 1 });
    expect(panel.canRetry).toBe(true);
    expect(panel.title).toContain('Image studio');
    expect(panel.detail).toBe(chunk.message);
  });

  it('STOPS offering a retry once the attempts are spent — a panel must not loop', () => {
    for (let attempts = 1; attempts <= MAX_ROUTE_RETRIES; attempts += 1) {
      expect(routePanel({ label: 'Image studio', error: chunk, attempts }).canRetry).toBe(true);
    }
    const spent = routePanel({
      label: 'Image studio',
      error: chunk,
      attempts: MAX_ROUTE_RETRIES + 1,
    });
    expect(spent.canRetry).toBe(false);
    // …and it still offers a way out, or the route is a dead end.
    expect(spent.reloadLabel.length).toBeGreaterThan(0);
  });

  it('reloads the DOCUMENT for a missing chunk and re-mounts for a render throw', () => {
    /* This distinction is the whole reason the two are separate: a stale chunk
     * is baked into the running document's module graph, so a soft re-mount
     * asks for the same missing URL again. */
    expect(routePanel({ label: 'Image studio', error: chunk, attempts: 1 }).reload).toBe(
      'document',
    );
    expect(routePanel({ label: 'Image studio', error: bug, attempts: 1 }).reload).toBe('remount');
  });

  it('says something different for a missing file and a broken screen', () => {
    const missing = routePanel({ label: 'Image studio', error: chunk, attempts: 1 });
    const broke = routePanel({ label: 'Image studio', error: bug, attempts: 1 });
    expect(missing.copy).not.toBe(broke.copy);
    // Both have to say the rest of the app is fine — that IS the fix.
    expect(missing.copy.toLowerCase()).toContain('still running');
    expect(broke.copy.toLowerCase()).toContain('untouched');
  });
});

describe('the armed-failure seam', () => {
  beforeEach(() => {
    armChunkFailure('Image studio', 0);
  });

  it('is inert until something arms it', async () => {
    expect(takeArmedFailure('Image studio')).toBeNull();
    await expect(loadRouteChunk('Image studio', () => Promise.resolve('loaded'))).resolves.toBe(
      'loaded',
    );
  });

  it('fails exactly as many imports as it was asked to', async () => {
    armChunkFailure('Image studio', 2);
    await expect(loadRouteChunk('Image studio', () => Promise.resolve('x'))).rejects.toThrow(
      /Failed to fetch dynamically imported module/,
    );
    await expect(loadRouteChunk('Image studio', () => Promise.resolve('x'))).rejects.toThrow();
    await expect(loadRouteChunk('Image studio', () => Promise.resolve('x'))).resolves.toBe('x');
  });

  it('rejects with something the panel classifies as a chunk failure', () => {
    armChunkFailure('Image studio', 1);
    const message = takeArmedFailure('Image studio');
    expect(message).not.toBeNull();
    // Otherwise the seam would drive a DIFFERENT panel than the real failure.
    expect(isChunkLoadError(new Error(message ?? ''))).toBe(true);
  });

  it('arms one route without arming its neighbour', async () => {
    armChunkFailure('Image studio', 1);
    await expect(loadRouteChunk('Video studio', () => Promise.resolve('v'))).resolves.toBe('v');
    await expect(loadRouteChunk('Image studio', () => Promise.resolve('i'))).rejects.toThrow();
  });
});

describe('chunkUrlFromError', () => {
  it('recovers the URL Chromium put in the message', () => {
    const url =
      'file:///Users/user/Desktop/OSS-harness/apps/desktop/dist/assets/ImageStudio-CPT1vDU_.js';
    expect(
      chunkUrlFromError(new Error(`Failed to fetch dynamically imported module: ${url}`)),
    ).toBe(url);
  });

  it('handles a served build too', () => {
    expect(
      chunkUrlFromError(
        new Error(
          'Failed to fetch dynamically imported module: http://localhost:5173/assets/a.mjs',
        ),
      ),
    ).toBe('http://localhost:5173/assets/a.mjs');
  });

  it('refuses a stylesheet — importing CSS as a module is a worse failure', () => {
    expect(
      chunkUrlFromError(new Error('Unable to preload CSS for /assets/Tripo-x.css')),
    ).toBeNull();
  });

  it('is null when the error names nothing to retry', () => {
    expect(chunkUrlFromError(new Error('Cannot read properties of undefined'))).toBeNull();
    expect(chunkUrlFromError(null)).toBeNull();
  });
});

describe('bustedChunkUrl', () => {
  it('makes a NEW module-map key, which is the only thing that re-fetches', () => {
    // MEASURED in the app: the same URL rejects instantly from the module map
    // even after the file is back; the same URL + a query loads.
    expect(bustedChunkUrl('file:///a/b.js', 1)).toBe('file:///a/b.js?pdRetry=1');
    expect(bustedChunkUrl('http://x/a.js?v=2', 3)).toBe('http://x/a.js?v=2&pdRetry=3');
  });
});
