/**
 * Terminal-tab PTY manager: one backend session per terminal canvas tab. The
 * renderer mounts xterm.js in the TerminalSurface slot; this module owns the
 * shell process and streams I/O over the `pty:*` channels.
 *
 * Backend selection is resilient. The preferred backend is **node-pty** (a real
 * PTY: line discipline, echo, TERM, resize). node-pty is a native addon, so its
 * `.node` binary must be rebuilt for Electron's ABI (see electron-builder.yml
 * asarUnpack + the `rebuild:native` script). When that binary isn't present /
 * loadable for this Electron ABI, we fall back to a **piped shell**
 * (`child_process.spawn` with stdio pipes). The fallback runs commands and
 * streams their output (so `echo hi` works), but has NO TTY: no real line
 * discipline, so we locally echo input and translate CR→LF ourselves, and
 * `resize` is a no-op. The active backend is reported back from `pty:spawn`.
 */
import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { PtyBackend } from './pty-contract';

const log = createLogger('desktop:pty');
const events = createIpcEventSender<AppEventMap>();
const nodeRequire = createRequire(import.meta.url);

// ── node-pty minimal shape (native optional dep; kept out of the type graph) ─
interface NodePtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): NodePtyProcess;
}

let ptyModuleCache: NodePtyModule | null | undefined;
function loadNodePty(): NodePtyModule | null {
  if (ptyModuleCache !== undefined) return ptyModuleCache;
  try {
    ptyModuleCache = nodeRequire('node-pty') as NodePtyModule;
    log.info('node-pty loaded — real PTY backend active');
  } catch (error) {
    ptyModuleCache = null;
    log.warn('node-pty unavailable — using piped-shell fallback', { error: String(error) });
  }
  return ptyModuleCache;
}

interface Session {
  backend: PtyBackend;
  owner: WebContents;
  pid: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const sessions = new Map<string, Session>();
const wiredOwners = new Set<number>();

function emitData(owner: WebContents, tabId: string, data: string): void {
  if (!owner.isDestroyed()) events.send(owner, 'pty:data', { tabId, data });
}
function emitExit(owner: WebContents, tabId: string, exitCode: number | null): void {
  if (!owner.isDestroyed()) events.send(owner, 'pty:exit', { tabId, exitCode });
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}

interface SpawnOpts {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * THE PROMPT SAYS BOBBLE AND WHERE IT IS.
 *
 * the user: "would be appreciated if you can show in the terminal something like
 * the user being 'bobble' and the directory." Left alone, the pane inherits the
 * login shell's own prompt — `user@My-MacBook-Pro ~ %` — which names the
 * machine (never in question) and hides the only thing that matters here, which
 * directory the agent's commands are landing in.
 *
 * `PS1` covers bash/sh directly (`\w` renders the cwd with `$HOME` as `~`). zsh
 * needs more than an env var — see {@link zshShimDir}.
 */
function promptEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PS1: '\\[\\033[38;5;39m\\]bobble\\[\\033[0m\\] \\w % ',
    // Marks the pane for anything that wants to know it is not a login terminal.
    BOBBLE_TERMINAL: '1',
  };
  const shim = zshShimDir();
  if (shim !== null) {
    /* Remember the real one so the shim can source the user's own files. */
    const real = process.env.ZDOTDIR;
    if (real !== undefined) env.BOBBLE_REAL_ZDOTDIR = real;
    env.ZDOTDIR = shim;
  }
  return env;
}

/**
 * MEASURED: exporting `PROMPT` does nothing for zsh — the default macOS shell.
 * An interactive zsh runs `.zshrc` AFTER the environment is applied, and that
 * file sets the prompt, so the pane kept showing `user@My-MacBook-Pro ~ %`
 * with the env var set. (Verified on screen before and after; the env-only
 * version was silently a no-op, which is the failure mode I keep meeting.)
 *
 * So: a shim ZDOTDIR whose `.zshrc` sources the user's real startup files FIRST
 * and only then overrides the prompt — their PATH, aliases and options all load
 * exactly as usual, and the last word on the prompt is ours. This is the same
 * approach VS Code's shell integration uses.
 *
 * Returns null if the shim cannot be written; the pane then just keeps the
 * system prompt, which is cosmetically wrong but entirely functional.
 */
let shimCache: string | null | undefined;
function zshShimDir(): string | null {
  if (shimCache !== undefined) return shimCache;
  try {
    const dir = path.join(os.tmpdir(), 'bobble-zdotdir');
    fs.mkdirSync(dir, { recursive: true });
    /* Falls back to $HOME the long way round rather than with `${VAR:-default}`,
     * which reads as a botched JS template literal to both a linter and a human
     * skimming it. Same behaviour, no ambiguity. */
    const rcHome = [
      'BOBBLE_RC_HOME="$BOBBLE_REAL_ZDOTDIR"',
      '[ -z "$BOBBLE_RC_HOME" ] && BOBBLE_RC_HOME="$HOME"',
    ];
    fs.writeFileSync(
      path.join(dir, '.zshrc'),
      [
        '# Written by Bobble. Sources your real zsh setup, then names the prompt.',
        ...rcHome,
        '[ -f "$BOBBLE_RC_HOME/.zshrc" ] && source "$BOBBLE_RC_HOME/.zshrc"',
        "PROMPT='%F{39}bobble%f %~ %# '",
        'unset BOBBLE_RC_HOME',
      ].join('\n'),
      'utf8',
    );
    /* zsh looks for these in ZDOTDIR too, so a missing shim copy would skip the
     * user's own — PATH most importantly. */
    for (const name of ['.zshenv', '.zprofile']) {
      fs.writeFileSync(
        path.join(dir, name),
        [
          ...rcHome,
          `[ -f "$BOBBLE_RC_HOME/${name}" ] && source "$BOBBLE_RC_HOME/${name}"`,
          'unset BOBBLE_RC_HOME',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    shimCache = dir;
  } catch (error) {
    log.warn('zsh prompt shim unavailable — keeping the system prompt', {
      error: String(error),
    });
    shimCache = null;
  }
  return shimCache;
}

function spawnNodePty(
  mod: NodePtyModule,
  tabId: string,
  owner: WebContents,
  opts: SpawnOpts,
): Session | null {
  try {
    const proc = mod.spawn(opts.shell, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, ...promptEnv() },
    });
    proc.onData((data) => emitData(owner, tabId, data));
    proc.onExit(({ exitCode }) => {
      sessions.delete(tabId);
      emitExit(owner, tabId, exitCode);
    });
    return {
      backend: 'node-pty',
      owner,
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  } catch (error) {
    log.warn('node-pty spawn failed — falling back to pipe', { error: String(error) });
    return null;
  }
}

function spawnPipe(tabId: string, owner: WebContents, opts: SpawnOpts): Session {
  const child: ChildProcessWithoutNullStreams = spawnChild(opts.shell, [], {
    cwd: opts.cwd,
    env: { ...process.env, TERM: 'xterm-256color', ...promptEnv() },
  });
  child.stdout.on('data', (chunk: Buffer) => emitData(owner, tabId, chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => emitData(owner, tabId, chunk.toString('utf8')));
  child.on('exit', (code) => {
    sessions.delete(tabId);
    emitExit(owner, tabId, code);
  });
  child.on('error', (error) => emitData(owner, tabId, `\r\n[pty] ${String(error)}\r\n`));
  return {
    backend: 'pipe',
    owner,
    pid: child.pid ?? null,
    write: (data) => {
      // No TTY: locally echo so typed input is visible (CR → CRLF for xterm),
      // and feed the shell CR → LF so it executes each line.
      emitData(owner, tabId, data.replace(/\r/g, '\r\n'));
      child.stdin.write(data.replace(/\r/g, '\n'));
    },
    resize: () => {
      /* no PTY to resize in the piped fallback */
    },
    kill: () => child.kill(),
  };
}

function wireOwnerTeardown(owner: WebContents): void {
  if (wiredOwners.has(owner.id)) return;
  wiredOwners.add(owner.id);
  owner.once('destroyed', () => {
    wiredOwners.delete(owner.id);
    for (const [tabId, session] of [...sessions]) {
      if (session.owner === owner) {
        session.kill();
        sessions.delete(tabId);
      }
    }
  });
}

interface SpawnRequest {
  tabId: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

function spawnSession(
  owner: WebContents,
  req: SpawnRequest,
): { pid: number | null; backend: PtyBackend } {
  const existing = sessions.get(req.tabId);
  if (existing !== undefined) return { pid: existing.pid, backend: existing.backend };
  const opts: SpawnOpts = {
    shell: req.shell ?? defaultShell(),
    cwd: req.cwd ?? os.homedir(),
    cols: req.cols ?? 80,
    rows: req.rows ?? 24,
  };
  const mod = loadNodePty();
  const session =
    (mod !== null && spawnNodePty(mod, req.tabId, owner, opts)) ||
    spawnPipe(req.tabId, owner, opts);
  sessions.set(req.tabId, session);
  wireOwnerTeardown(owner);
  log.info('pty spawned', { tabId: req.tabId, backend: session.backend, pid: session.pid });
  return { pid: session.pid, backend: session.backend };
}

/**
 * Kill every live PTY/shell session — the app-quit teardown hook. Terminal
 * children are normally reaped when their owner WebContents is destroyed
 * (wireOwnerTeardown), but a quit that tears the app down before window-close
 * would otherwise leave shells running, so reap them all here too.
 */
export function disposeAllPtys(): void {
  for (const [tabId, session] of [...sessions]) {
    try {
      session.kill();
    } catch {
      // already gone
    }
    sessions.delete(tabId);
  }
}

/** Register the trusted-sender-gated `pty:*` channels. */
export function registerPtyIpc(): void {
  const handle = (
    channel: string,
    handler: (owner: WebContents, req: Record<string, unknown>) => unknown,
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, req) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel });
        throw new Error(`[pty] rejected "${channel}": untrusted sender`);
      }
      return handler(event.sender, req as Record<string, unknown>);
    });
  };

  handle('pty:spawn', (owner, req) => {
    const { pid, backend } = spawnSession(owner, req as unknown as SpawnRequest);
    return { ok: true, pid, backend };
  });
  handle('pty:write', (_owner, req) => {
    sessions.get(req.tabId as string)?.write(req.data as string);
    return { ok: true };
  });
  handle('pty:resize', (_owner, req) => {
    sessions.get(req.tabId as string)?.resize(req.cols as number, req.rows as number);
    return { ok: true };
  });
  handle('pty:kill', (_owner, req) => {
    const session = sessions.get(req.tabId as string);
    if (session !== undefined) {
      session.kill();
      sessions.delete(req.tabId as string);
    }
    return { ok: true };
  });
}
