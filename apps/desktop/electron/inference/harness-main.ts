/**
 * FINDING THE CODING HARNESSES ALREADY ON THIS MACHINE.
 *
 * the user: "system pi detected and put in also". A harness picker that lists agents
 * without checking whether they exist is a menu of future error messages, so the
 * panel only offers what this probe actually found.
 *
 * WHY NOT `which`. A GUI app on macOS does not inherit the shell's PATH — it
 * gets launchd's, which typically lacks /opt/homebrew/bin, ~/.local/bin and
 * every version-manager shim. So `which claude` from here says "not installed"
 * for a user who has it working in their terminal, which is the most annoying
 * possible wrong answer. This searches the places those tools actually install
 * to, in addition to PATH.
 *
 * The renderer passes the ids and bin names from its own catalog, so adding a
 * harness stays a one-file data edit rather than a change on both sides of IPC.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HarnessDetected } from '../ipc-contract';

/** Where CLI agents land, beyond whatever PATH this process happens to have. */
function searchDirs(): string[] {
  const home = homedir();
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter((p) => p.length > 0);
  return [
    ...fromPath,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
  ];
}

function findBinary(bin: string): string | undefined {
  for (const dir of searchDirs()) {
    const full = path.join(dir, bin);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      /* unreadable dir: not a match */
    }
  }
  return undefined;
}

/**
 * Ask the binary its version. Best-effort and short-fused: a harness that hangs
 * on `--version` must not hang the settings panel, and a missing version is
 * cosmetic — `installed` is already decided by the path.
 */
function versionOf(binPath: string): string | undefined {
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.trim().split('\n')[0]?.trim();
    return first !== undefined && first.length > 0 && first.length < 80 ? first : undefined;
  } catch {
    return undefined;
  }
}

export function detectHarnesses(
  probes: ReadonlyArray<{ id: string; bin: string }>,
): HarnessDetected[] {
  return probes.map(({ id, bin }) => {
    const found = findBinary(bin);
    if (found === undefined) return { id, installed: false };
    return { id, installed: true, path: found, version: versionOf(found) };
  });
}
