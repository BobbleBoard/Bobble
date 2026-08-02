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
}

function runViaBridge(
  socketPath: string,
  token: string,
  req: CorpRunRequest,
): Promise<CorpRunResult> {
  return new Promise<CorpRunResult>((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (r: CorpRunResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
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
     * shape. Abort travels the other way: the user stops the run, the app
     * answers this socket.
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
        };
        done({
          ok: res.ok === true,
          // `summary` accepted as an alias so the app half can reuse the
          // subagent responder's shape without a second field name.
          product: res.product ?? res.summary ?? '',
          ...(res.error !== undefined ? { error: res.error } : {}),
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
): ((req: CorpRunRequest) => Promise<CorpRunResult>) | null {
  const socketPath = env[SOCK_ENV];
  const token = env[TOKEN_ENV];
  if (socketPath === undefined || socketPath === '' || token === undefined || token === '') {
    return null;
  }
  return (req) => runViaBridge(socketPath, token, req);
}
