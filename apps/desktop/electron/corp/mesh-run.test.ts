/**
 * The mesh's product evidence — the check the DEFAULT path did not have.
 *
 * `preflightProduct` and `runProductGate` were both built to stop narrative
 * "production-ready" sign-offs, and both were wired only into `runCorp`, which
 * is the solo (low/medium effort) path. High and max run the mesh. These pin
 * that a mesh reply now arrives with evidence beside it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withProductEvidence } from './mesh-run';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-mesh-evidence-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const check = (body: string): void => {
  const p = path.join(dir, 'check');
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};

describe('withProductEvidence', () => {
  it("contradicts a confident sign-off when the product's own check fails", async () => {
    check('echo "3 tests, 1 failed"; exit 1');
    const out = await withProductEvidence('All done — production ready.', dir);
    expect(out).toContain('All done — production ready.');
    expect(out).toContain('does NOT pass its own check');
    expect(out).toContain('3 tests, 1 failed');
  });

  it('confirms a passing check, so the CEO reads more than an assertion', async () => {
    check('exit 0');
    const out = await withProductEvidence('Shipped.', dir);
    expect(out).toContain("product's own check passes");
  });

  it('reports a web entry that cannot load', async () => {
    writeFileSync(path.join(dir, 'index.html'), '<script type="module" src="./app.js"></script>');
    const out = await withProductEvidence('The page is live.', dir);
    expect(out).toContain('DOES NOT LOAD');
  });

  it('stays quiet when a run left nothing to check', async () => {
    // A run that delivered a document or an image has no check to fail, and
    // saying "unverifiable" every time trains the reader to skip the block.
    mkdirSync(path.join(dir, 'notes'));
    const out = await withProductEvidence('Here is the summary you asked for.', dir);
    expect(out).toBe('Here is the summary you asked for.');
  });

  it('never throws on a workspace it cannot read', async () => {
    await expect(withProductEvidence('reply', '/nope/does/not/exist')).resolves.toBe('reply');
    await expect(withProductEvidence('reply', undefined)).resolves.toBe('reply');
  });
});
