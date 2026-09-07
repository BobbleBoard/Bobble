/**
 * EVERY UTILITY CALL GOES THROUGH ONE DOOR.
 *
 * `wireHarness` wraps the callModel it hands out (`watchSlot`) so that finishing
 * a background call announces that it moved llama-server's single KV slot — the
 * signal the composer uses to put the user's own prefix back. That only holds
 * while `wireHarness` is the only place a callModel is obtained: a module that
 * builds its own with `createOpenAiCompatCallModel` would write to the slot
 * silently, and the symptom (a finished prefill mysteriously not helping the
 * send that follows) is one of the hardest things in this codebase to trace
 * back to its cause. It cost most of a day once.
 *
 * So this is a source-level guard rather than a behavioural one. If it fails,
 * the fix is not to add the file to the list — it is to take the callModel from
 * the harness, or to move the announcement into the constructor.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts file under packages/harness/src, tests excluded. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('utility calls have one way in', () => {
  it('only call-model.ts builds a callModel, and only index.ts re-exports it', () => {
    const allowed = new Set(['model-call/call-model.ts', 'index.ts']);
    const offenders = sources(SRC)
      .filter((file) =>
        /createOpenAiCompatCallModel|callModelFromEnv/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !allowed.has(rel));
    expect(offenders).toEqual([]);
  });
});
