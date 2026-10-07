/**
 * FIND THE PROGRAM A CONNECTOR RUNS ON — the way a person's own shell would.
 *
 * A connector is `npx …` or `uvx …`, spawned by name. A Bobble opened from the
 * Finder gets the bare system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — the same
 * reason every generated picture once failed with "uv is required" while
 * `~/.local/bin/uv` sat on the disk (apps/desktop/electron/main.ts). So 27 of
 * the 29 catalog connectors could not start in the installed app, and the error
 * was `spawn npx ENOENT`.
 *
 * This looks where those tools are actually installed (Homebrew, the uv / cargo
 * / Volta / Bun bins, the newest nvm Node), puts that folder at the front of the
 * server's PATH (npx's own `#!/usr/bin/env node` needs `node` beside it), runs a
 * missing `uvx` through the app's own uv (`uv tool run` — the bootstrap images,
 * 3D and Python already share), and when the runtime truly is not on this Mac
 * says so in a sentence a person can act on.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ResolvedCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Folders to put in front of the server's PATH. */
  readonly pathPrefix: readonly string[];
}

export interface ResolveDeps {
  readonly exists?: (file: string) => boolean;
  readonly home?: string;
  /** Directory names under `dir`, for the newest nvm Node. */
  readonly listDir?: (dir: string) => readonly string[];
  /** The app's uv (finding or fetching it); absent → a missing uvx is an error. */
  readonly ensureUv?: () => Promise<string>;
}

/** Where people's runtimes live on a Mac, beyond the system PATH. */
export function extraBinDirs(home: string, listDir: (dir: string) => readonly string[]): string[] {
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  const newestNvm = [...listDir(nvm)]
    .filter((v) => /^v\d+/.test(v))
    .sort((a, b) => compareVersions(b, a))[0];
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...(newestNvm !== undefined ? [path.join(nvm, newestNvm, 'bin')] : []),
    '/opt/local/bin',
  ];
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** What to tell a person when the program a connector needs is not on this Mac. */
export function missingRuntimeMessage(command: string): string {
  if (/^(npx|npm|node|pnpm|bunx|yarn)$/.test(command)) {
    return (
      `This connector runs on Node.js (\`${command}\`), which isn't installed on this Mac. ` +
      'Install Node.js from nodejs.org, then turn the connector off and on again.'
    );
  }
  if (command === 'docker') {
    return "This connector runs in Docker, which isn't installed on this Mac.";
  }
  return `This connector runs \`${command}\`, which isn't installed on this Mac.`;
}

/**
 * The executable to spawn for `command`, searching `envPath` then the usual
 * install folders. Throws an Error carrying {@link missingRuntimeMessage} when
 * nothing is found (after trying the app's uv for `uvx` / `uv`).
 */
export async function resolveServerCommand(
  command: string,
  args: readonly string[],
  envPath: string | undefined,
  deps: ResolveDeps = {},
): Promise<ResolvedCommand> {
  if (command.includes('/')) return { command, args, pathPrefix: [] };
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const listDir =
    deps.listDir ??
    ((dir: string) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    });
  const onPath = (envPath ?? '').split(':').filter((d) => d !== '');
  for (const dir of onPath) {
    const file = path.join(dir, command);
    if (exists(file)) return { command: file, args, pathPrefix: [] };
  }
  for (const dir of extraBinDirs(home, listDir)) {
    if (onPath.includes(dir)) continue;
    const file = path.join(dir, command);
    if (exists(file)) return { command: file, args, pathPrefix: [dir] };
  }
  if ((command === 'uvx' || command === 'uv') && deps.ensureUv !== undefined) {
    const uv = await deps.ensureUv();
    return {
      command: uv,
      args: command === 'uvx' ? ['tool', 'run', ...args] : args,
      pathPrefix: [path.dirname(uv)],
    };
  }
  throw new Error(missingRuntimeMessage(command));
}
