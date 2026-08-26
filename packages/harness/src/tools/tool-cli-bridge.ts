/**
 * EVERY TOOL AS A COMMAND — the live half.
 *
 * {@link tool-cli.ts} decides what a command line MEANS; this file makes the
 * commands exist. One shim per group is written into a 0700 directory that is
 * prepended to PATH, so `media generate image "a fox"` typed into the `bash`
 * tool reaches the harness's own tool registry and runs the same code a
 * structured tool call would have run.
 *
 * THE MECHANISM IS BORROWED, DELIBERATELY. mcp-lite already ships this exact
 * bridge for MCP connectors — POSIX shim → Electron-as-Node dispatcher →
 * token-gated Unix socket → in-process router — and it has been in the app long
 * enough to be trusted. Rebuilding it differently here would mean two ways to be
 * wrong. What is new is the SOURCE of the commands: the harness registry rather
 * than a connector host, which is what lets a generation tool and a Notion tool
 * sit on the same PATH.
 *
 * IT GRANTS NO NEW CAPABILITY. The model already has unrestricted `bash`, and
 * every command here routes to a tool it could already call. The socket lives in
 * a 0700 dir, every request must echo a per-session token, and the whole thing
 * is torn down on dispose.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCli,
  type CliGroupSpec,
  type CliModel,
  type CliTool,
  resolveCli,
} from './tool-cli.js';

export const TOOL_CLI_SOCK_ENV = 'PI_TOOLCLI_SOCK';
export const TOOL_CLI_TOKEN_ENV = 'PI_TOOLCLI_TOKEN';

/** What the bridge needs from the harness to actually run a tool. */
export interface ToolCliHost {
  /** Every registered tool, with its schema — the CLI is rebuilt per request. */
  tools: () => readonly CliTool[];
  /** Capability groups; the CLI's command names come from these. */
  groups: () => readonly CliGroupSpec[];
  /** Run a tool by name. Returns the text the command prints. */
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
}

export interface ToolCliOptions {
  readonly shimDir?: string;
  readonly socketPath?: string;
  readonly token?: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onLog?: (m: string) => void;
}

export interface ToolCliHandle {
  readonly shimDir: string;
  readonly socketPath: string;
  readonly commands: readonly string[];
  dispose: () => void;
}

/**
 * The POSIX shim. One per group, plus `tools`.
 *
 * `exec` rather than a subshell so signals and exit codes pass straight
 * through, and ELECTRON_RUN_AS_NODE so the app's own binary can act as the Node
 * that runs the dispatcher — there is no system Node to depend on.
 */
export function buildShim(execPath: string, dispatcherPath: string, command: string): string {
  return [
    '#!/bin/sh',
    `# ${command} — a Bobble tool, reachable as a command.`,
    `ELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${dispatcherPath}" ${command} "$@"`,
    '',
  ].join('\n');
}

/**
 * The dispatcher: argv → socket → text on stdout.
 *
 * Written as source rather than shipped as a file because it has to live beside
 * the shims in the temp dir the shims point at, and because it must not depend
 * on anything in the app bundle's module graph.
 */
export function buildDispatcherSource(): string {
  return `
const net = require('node:net');
const sock = process.env['${TOOL_CLI_SOCK_ENV}'];
const token = process.env['${TOOL_CLI_TOKEN_ENV}'];
const argv = process.argv.slice(2);
if (!sock) { console.error('tool bridge not available in this shell'); process.exit(2); }
const c = net.createConnection(sock);
let buf = '';
const timer = setTimeout(() => { console.error('tool bridge timed out'); process.exit(3); }, 120000);
c.on('connect', () => c.write(JSON.stringify({ token, argv }) + '\\n'));
c.on('data', (d) => {
  buf += d.toString();
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  clearTimeout(timer);
  let res = {};
  try { res = JSON.parse(buf.slice(0, nl)); } catch { res = { text: 'bridge: bad response', isError: true }; }
  if (res.text) process.stdout.write(String(res.text) + '\\n');
  c.end();
  process.exit(res.isError ? 1 : 0);
});
c.on('error', (e) => { clearTimeout(timer); console.error('tool bridge: ' + e.message); process.exit(4); });
`;
}

/** Install the shims + socket. Returns a disposer that removes both. */
export function registerToolCli(host: ToolCliHost, opts: ToolCliOptions = {}): ToolCliHandle {
  const suffix = randomBytes(6).toString('hex');
  const shimDir = opts.shimDir ?? path.join(os.tmpdir(), `pi-toolcli-${suffix}`);
  const socketPath = opts.socketPath ?? path.join(os.tmpdir(), `pi-toolcli-${suffix}.sock`);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const onLog = opts.onLog ?? (() => {});

  const dispatcherPath = path.join(shimDir, 'dispatcher.js');
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(dispatcherPath, buildDispatcherSource(), 'utf8');

  /*
   * A shim per group, written from the CURRENT registry. `tools` always exists,
   * because a shell whose only discovery command is missing is a shell you
   * cannot find anything in.
   */
  const cli = buildCli(host.groups(), host.tools());
  const commands = ['tools', ...cli.groups.map((g) => g.name)];
  for (const command of commands) {
    const p = path.join(shimDir, command);
    fs.writeFileSync(p, buildShim(execPath, dispatcherPath, command), { mode: 0o755 });
  }

  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // stale socket; listen() will surface anything real.
  }
  const server = net.createServer((socket) => handle(socket, host, token));
  server.on('error', (e) => onLog(`tool-cli bridge error: ${String(e)}`));
  server.listen(socketPath);

  const prevPath = env.PATH;
  env.PATH = prevPath ? `${shimDir}${path.delimiter}${prevPath}` : shimDir;
  env[TOOL_CLI_SOCK_ENV] = socketPath;
  env[TOOL_CLI_TOKEN_ENV] = token;

  let disposed = false;
  return {
    shimDir,
    socketPath,
    commands,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        server.close();
      } catch {
        /* best-effort */
      }
      for (const p of [socketPath]) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
      try {
        fs.rmSync(shimDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      if (prevPath === undefined) delete env.PATH;
      else env.PATH = prevPath;
      delete env[TOOL_CLI_SOCK_ENV];
      delete env[TOOL_CLI_TOKEN_ENV];
    },
  };
}

/**
 * Route one request.
 *
 * The CLI is rebuilt from the registry per request rather than captured at
 * install time: an extension that registers a tool later in the session should
 * be reachable without restarting the shell, and a tool that went away should
 * stop being listed rather than answering "unknown".
 */
export async function dispatchToolCli(
  host: ToolCliHost,
  argv: readonly string[],
): Promise<{ text: string; isError: boolean }> {
  const cli: CliModel = buildCli(host.groups(), host.tools());
  const res = resolveCli(cli, argv);
  if (res.kind === 'text') return { text: res.text, isError: false };
  if (res.kind === 'error') return { text: res.text, isError: true };
  try {
    return await host.call(res.tool, res.args);
  } catch (e) {
    return { text: `${res.tool}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

function handle(socket: net.Socket, host: ToolCliHost, token: string): void {
  let buffer = '';
  socket.on('data', (d) => {
    buffer += d.toString();
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let req: { token?: string; argv?: unknown } = {};
    try {
      req = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ text: 'bridge: bad request', isError: true })}\n`);
      return;
    }
    if (req.token !== token) {
      socket.end(`${JSON.stringify({ text: 'bridge: unauthorized', isError: true })}\n`);
      return;
    }
    const argv = Array.isArray(req.argv) ? req.argv.map((a) => String(a)) : [];
    void dispatchToolCli(host, argv).then(
      (r) => socket.end(`${JSON.stringify(r)}\n`),
      (e) => socket.end(`${JSON.stringify({ text: String(e), isError: true })}\n`),
    );
  });
  socket.on('error', () => socket.destroy());
}
