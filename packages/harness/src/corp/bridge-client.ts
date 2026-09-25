/**
 * Corp bridge client — the pi-child half of `talk_to_manager`.
 *
 * THE CALL BLOCKS. the user: "the ceo calls the manager, this should stop the CEO
 * cold, and run the manager; the ceo should not get a tool result from the
 * manager until the manager has run everything and is ready to submit the whole
 * working product — as far as the ceo knows they call manager and receive the
 * complete working product."
 *
 * It used to publish a status signal and return a fixed ack immediately, so the
 * CEO was told "your manager has it" within seconds and — still holding its own
 * tools, as it should — carried on and built the thing itself in parallel while
 * the manager sat queued. Blocking is what stops that: a pending tool call
 * suspends the CEO structurally, without taking a single tool away from it.
 *
 * Transport is the SAME Unix socket `spawn_subagent` already uses (its path and
 * token are published on the env before the first pi spawn); this just adds a
 * `corp` method. Shapes mirror subagent/bridge-client.ts deliberately.
 */
import net from 'node:net';

const SOCK_ENV = 'PI_DESKTOP_SUBAGENT_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_SUBAGENT_TOKEN';
const CONNECT_TIMEOUT_MS = 5_000;

export interface CorpRunRequest {
  /** The CEO's OWN words to the manager — the vision, in full. Not the user's
   * prompt: the manager has never spoken to the user and knows only this. */
  readonly message: string;
  /** Where the work happens. */
  readonly cwd?: string;
}

export interface CorpRunResult {
  readonly ok: boolean;
  /** What the team delivered, as the CEO should read it. */
  readonly product: string;
  readonly error?: string;
  /**
   * WHAT IS ACTUALLY IN THE WORKSPACE, filled in by the host that ran the team
   * (only it knows the cwd; this package stays electron-free).
   *
   * Exists because "the team returned nothing usable" was being turned into
   * "Nothing was delivered", and those are different facts. MEASURED, run 2: the
   * manager exhausted its step budget mid-coordination and never replied, so the
   * CEO was told nothing was delivered — over 18 source files, 2,452 lines and a
   * clean TypeScript build sitting on disk. An empty REPLY says the manager never
   * spoke. It says nothing whatsoever about the tree.
   */
  readonly workspace?: string;
  /** The CEO's turn was stopped before the team delivered (and the team with it). */
  readonly stopped?: boolean;
}

function runViaBridge(
  socketPath: string,
  token: string,
  req: CorpRunRequest,
  signal?: AbortSignal,
): Promise<CorpRunResult> {
  return new Promise<CorpRunResult>((resolve) => {
    if (signal?.aborted === true) {
      resolve({ ok: false, product: '', error: 'stopped', stopped: true });
      return;
    }
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (r: CorpRunResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(r);
    };
    /*
     * THE CEO'S TURN WAS STOPPED. pi ends a turn only once this call returns,
     * so waiting for the team held a Stop for the whole production. Hang up:
     * the app reads a closed socket as the CEO gone and stops the team.
     */
    const onAbort = (): void => done({ ok: false, product: '', error: 'stopped', stopped: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    const connectTimer = setTimeout(
      () => done({ ok: false, product: '', error: 'corp bridge connect timed out' }),
      CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref?.();

    /*
     * NO OVERALL TIMEOUT — deliberately, unlike the subagent bridge.
     *
     * A real production run is tens of minutes to hours; every measured Godot
     * build in this repo ran 20-90 minutes. A backstop here would abort the run
     * from the wrong side and hand the CEO a lie ("timed out") about a team
     * still working. The app owns the run's lifetime and its abort, and the
     * harness's per-call watchdog does not cover tool calls anyway (it arms on
     * before_provider_request), so a long tool call is already the supported
     * shape. Abort travels both ways: the user stops the run and the app
     * answers this socket, or the CEO's turn is stopped and this socket hangs
     * up (see onAbort above).
     */
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({
          id: 1,
          token,
          method: 'corp',
          params: { message: req.message, cwd: req.cwd },
        })}\n`,
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buffer.slice(0, nl)) as {
          ok?: boolean;
          product?: string;
          summary?: string;
          error?: string;
          workspace?: string;
        };
        done({
          ok: res.ok === true,
          // `summary` accepted as an alias so the app half can reuse the
          // subagent responder's shape without a second field name.
          product: res.product ?? res.summary ?? '',
          ...(res.error !== undefined ? { error: res.error } : {}),
          /*
           * CARRY THE WORKSPACE. It is what stops a failed hand-off being
           * reported as an empty one — see CorpRunResult.workspace and the
           * promote-tool message it feeds.
           *
           * This line is the whole reason that fix did not work the first time.
           * The field was added to the type, set by the host, and read by the
           * consumer; this parse in the middle picks fields explicitly and
           * silently dropped it, so run 4's CEO was told "Nothing was delivered"
           * over a real tree for the second run running. A response parser that
           * enumerates fields needs updating with every field, and nothing warns
           * you — the type is on the RESULT, not on the wire.
           */
          ...(res.workspace !== undefined ? { workspace: res.workspace } : {}),
        });
      } catch {
        done({ ok: false, product: '', error: 'bad corp bridge response' });
      }
    });
    socket.on('error', (e) => done({ ok: false, product: '', error: `corp bridge: ${String(e)}` }));
  });
}

/**
 * A blocking `runCorp`, or `null` when the bridge env isn't present (running
 * outside Pi Desktop — the caller falls back to the publish-and-ack path, which
 * is all a headless harness can do).
 */
export function corpBridgeRunFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ((req: CorpRunRequest, signal?: AbortSignal) => Promise<CorpRunResult>) | null {
  const socketPath = env[SOCK_ENV];
  const token = env[TOKEN_ENV];
  if (socketPath === undefined || socketPath === '' || token === undefined || token === '') {
    return null;
  }
  return (req, signal) => runViaBridge(socketPath, token, req, signal);
}
