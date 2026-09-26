/**
 * A SERVER STARTED IN THE FOREGROUND IS SEEN — AND STOPPED — IN SECONDS.
 *
 * MEASURED (4B, the visual suite, "build me an interactive widget"): the model
 * wrote its page, then ran `python3 -m http.server 8080` to look at it. A
 * server never returns, so the call sat until the five-minute clock
 * (withDefaultTimeout) took it back — five of the task's eight minutes, spent
 * waiting on a process whose one line of output said it was ready.
 *
 * NO LIST OF SERVER COMMANDS. the user, of the launcher blocklist this replaced:
 * "the deterministic guard here is again something we need to let go of, how
 * can you make this general and reliable". The evidence here is a fact about
 * the running program, not a guess from its name: a process THIS command
 * started is LISTENING on a TCP port, and the command has gone quiet. That is
 * what a server is — http.server, vite, a Flask app, a binary nobody has
 * heard of — and a test run that opens a port while it prints its progress
 * is not quiet.
 *
 * Then the command is stopped through the tool's own abort (pi kills the
 * process tree) and control comes back with what it printed and why: a
 * server that should keep running is started with `background: true`, and a
 * page needs no server at all — present opens the file. And the way through,
 * as every refusal here has one: the same command run again is left alone.
 */
import { execFile } from 'node:child_process';

/** One listening TCP socket: the process holding it and its port. */
export interface Listener {
  readonly pid: number;
  readonly port: string;
}

/** How the running system is read. Injected in tests. */
export interface ServerProbe {
  /** Every TCP socket in LISTEN that this user can see. */
  listeners(): Promise<Listener[]>;
  /** pid → parent pid, for every process. */
  parents(): Promise<Map<number, number>>;
}

const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    // lsof exits 1 when nothing matches; the output is what counts.
    execFile(file, args, { timeout: 4000 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });

/** `lsof -Fpn` output → listeners. */
export function parseLsof(out: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith('n') && pid > 0) {
      const port = /:(\d+)$/.exec(line.slice(1))?.[1];
      if (port !== undefined && !found.some((l) => l.pid === pid && l.port === port)) {
        found.push({ pid, port });
      }
    }
  }
  return found;
}

/** `ps -A -o pid=,ppid=` output → pid → parent. */
export function parsePs(out: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

export const systemProbe: ServerProbe = {
  listeners: async () => parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])),
  parents: async () => parsePs(await run('ps', ['-A', '-o', 'pid=,ppid='])),
};

/** Is `pid` `root` or one of its descendants? */
export function descendsFrom(
  pid: number,
  root: number,
  parents: ReadonlyMap<number, number>,
): boolean {
  let p = pid;
  for (let hops = 0; p > 1 && hops < 128; hops += 1) {
    if (p === root) return true;
    p = parents.get(p) ?? 0;
  }
  return false;
}

/** What the model reads when its command was a server. */
export function serverStoppedText(output: string, port: string): string {
  const printed = output.replace(/\n*Command aborted\s*$/, '').trimEnd();
  return [
    ...(printed === '' ? [] : [printed, '']),
    `Stopped: this command started a server — it was listening on port ${port} and had ` +
      'gone quiet, and a server never returns on its own, so it would have held this turn ' +
      'until the clock ran out. A page needs no server: present opens the file itself. To ' +
      'keep a server running while you work, run it with `background: true`. If this was ' +
      'not a server and should run to the end, run the same command again — it will not ' +
      'be stopped a second time.',
  ].join('\n');
}

export interface ForegroundServerOptions {
  readonly probe?: ServerProbe;
  /** The process whose descendants the command's processes are (this pi). */
  readonly root?: number;
  /** How long a command runs before it is looked at. */
  readonly graceMs?: number;
  /** How often it is looked at after that. */
  readonly everyMs?: number;
  /** How long it must have printed nothing, with a port open, to be a server. */
  readonly quietMs?: number;
}

/**
 * Wrap a bash tool so a command that turns out to be a foreground server is
 * stopped as soon as that is certain, instead of when the clock runs out.
 */
export function withForegroundServerStop<T extends { execute: (...a: never[]) => unknown }>(
  base: T,
  opts: ForegroundServerOptions = {},
): T {
  const probe = opts.probe ?? systemProbe;
  const root = opts.root ?? process.pid;
  const graceMs = opts.graceMs ?? 2500;
  const everyMs = opts.everyMs ?? 2000;
  const quietMs = opts.quietMs ?? 6000;
  /** Commands stopped once — the way through is to run them again. */
  const stoppedOnce = new Set<string>();
  return {
    ...base,
    async execute(...args: never[]) {
      const a = args as unknown[];
      const params = a[1] as { command?: unknown } | undefined;
      const command = typeof params?.command === 'string' ? params.command : '';
      if (command === '' || stoppedOnce.has(command)) {
        return (base.execute as (...x: never[]) => Promise<unknown>)(...args);
      }
      // Who was alive before: nothing the command starts can be in this set.
      const before = await probe.parents().catch(() => new Map<number, number>());
      const outer = a[2] as AbortSignal | undefined;
      const stop = new AbortController();
      const relay = (): void => stop.abort(outer?.reason);
      if (outer?.aborted === true) stop.abort(outer.reason);
      else outer?.addEventListener('abort', relay, { once: true });
      a[2] = stop.signal;
      let lastOutputAt = Date.now();
      const onUpdate = a[3] as ((u: unknown) => void) | undefined;
      a[3] = (u: unknown): void => {
        lastOutputAt = Date.now();
        onUpdate?.(u);
      };
      let server: Listener | null = null;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const look = async (): Promise<void> => {
        if (finished) return;
        try {
          if (Date.now() - lastOutputAt >= quietMs) {
            const [open, parents] = await Promise.all([probe.listeners(), probe.parents()]);
            const mine = open.find((l) => !before.has(l.pid) && descendsFrom(l.pid, root, parents));
            if (mine !== undefined && !finished) {
              server = mine;
              stop.abort(new Error('foreground server'));
              return;
            }
          }
        } catch {
          // A probe that fails is a probe that says nothing; the clock still holds.
        }
        if (!finished) timer = setTimeout(() => void look(), everyMs);
      };
      timer = setTimeout(() => void look(), graceMs);
      try {
        return await (base.execute as (...x: never[]) => Promise<unknown>)(...args);
      } catch (e) {
        const found = server as Listener | null;
        if (found === null || outer?.aborted === true) throw e;
        stoppedOnce.add(command);
        throw new Error(serverStoppedText(e instanceof Error ? e.message : String(e), found.port));
      } finally {
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        outer?.removeEventListener('abort', relay);
      }
    },
  } as T;
}
