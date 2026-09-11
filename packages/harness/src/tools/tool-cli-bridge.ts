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
import { retargetToolNames } from '../prompt/capability-prompt.js';
import {
  buildCli,
  type CliGroupSpec,
  type CliModel,
  type CliTool,
  resolveCli,
} from './tool-cli.js';
import { toolCliShimCommands } from './tool-cli-groups.js';

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
  /** Must exceed the bash tool's timeout. See DEFAULT_DISPATCH_TIMEOUT_MS. */
  readonly dispatchTimeoutMs?: number;
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
 * A shadowed media tool: says what to run instead, and fails.
 *
 * Exits non-zero so the model reads it as the failure it is rather than as
 * output to carry on from, and names the actual command rather than only
 * refusing — a dead end invites a workaround, a signpost does not.
 */
export function buildDecoy(name: string, suggestion: string): string {
  return [
    '#!/bin/sh',
    `# ${name} — shadowed while Bobble's tool commands are on PATH.`,
    `echo "${name} is not how this app makes media. Use: ${suggestion}" >&2`,
    `echo "Run \`${suggestion.split(' ')[0]} --help\` to see what it can do." >&2`,
    'exit 127',
    '',
  ].join('\n');
}

/**
 * `open`, wrapped rather than shadowed.
 *
 * `open -a <App>` ACTIVATES the app: it comes to the front and takes the user's
 * screen away mid-sentence. That is the one thing this product promises not to
 * do, and MEASURED across two models it is the first thing either reaches for
 * when asked to work in a Mac app — before, and instead of, the `mac` command
 * sitting on the same PATH.
 *
 * So only that form is redirected, and it is redirected to the command that
 * does the same job properly: `mac launch` opens the app in the background and
 * hands back its window. `-g` is already the background flag, so it passes
 * through, and every other use of `open` — a file, a URL, a directory — is the
 * real thing, because those are legitimate and refusing them would be a dead
 * end rather than a signpost.
 */
/** The real home, read from the password database rather than a $HOME that may
 * be a test harness's lie. */
function userHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return process.env.HOME ?? '/';
  }
}

/** Single-quote a value for /bin/sh. */
function shellQuote(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

export function buildOpenWrapper(): string {
  return [
    '#!/bin/sh',
    "# open — wrapped while Bobble's tool commands are on PATH.",
    /*
     * AND WHATEVER STILL REACHES /usr/bin/open GOES WITH THE USER'S OWN HOME.
     *
     * `mac launch` already sanitises this (see electron/mac/launch-env.ts), but
     * the model's shell does not: a probe's throwaway HOME is inherited by
     * anything bash starts, so `open -g -a "Google Chrome"` brings up a Chrome
     * with no profile and no keychain — the picker and the "A keychain cannot be
     * found" prompt the user reported, both in front of him. Same bug, other route.
     */
    `HOME=${shellQuote(userHome())}`,
    'export HOME',
    /*
     * TRANSLATE IT, DO NOT ARGUE WITH IT.
     *
     * `open -a Foo` is the right intent said with the wrong verb: the model
     * wants the app open and under its control, and the only thing wrong with
     * `open -a` is that it throws the app in the user's face. `mac launch` does
     * exactly what was meant. So run it.
     *
     * This started as a refusal with a signpost, and MEASURED twice, the
     * signpost was not taken. A 4B asked to use Calculator ran `open -a
     * Calculator`, was told to run `mac launch --app "Calculator"`, ran
     * `open -a "Calculator"` instead — it read the failure as a quoting problem —
     * and then answered the arithmetic out of its own head, never touching the
     * app. Translating removes the decision: the command works, the app opens in
     * the background, and its window comes back to act on.
     *
     * The app name is the argument AFTER the flag, so it is captured as the loop
     * walks; `--application=Foo` and `-aFoo` count too, since a model that wrote
     * either would otherwise be redirected to nothing. A bundle id (`-b`) is not
     * a name, and neither is a bare `-a` with nothing after it, so those still
     * refuse — with the app named when we know it.
     */
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are SHELL
    // parameter expansions inside a /bin/sh script, not JS template literals.
    'app=""',
    'prev=""',
    'flagged=""',
    'bundle=""',
    'url=""',
    'for arg in "$@"; do',
    '  case "$prev" in',
    '    -a|--application) app="$arg" ;;',
    '    -b) bundle="$arg" ;;',
    '  esac',
    '  case "$arg" in',
    /* `-n` opens a SECOND instance. REPORTED by the user mid-run: "keychain not
       found popup persists, chrome profile screen taking focus" — a 4B had run
       `open -n "Google Chrome"`, and a second Chrome comes up with no profile
       chosen and no keychain, so it shows the picker AND a keychain prompt, both
       in front of the user. There is never a reason to want a second copy of the
       app the user already has open. */
    '    -n|--new) flagged=1 ;;',
    '    -g|--background) exec /usr/bin/open "$@" ;;',
    // A URL is the OTHER form that takes the screen: `open <url>` hands the page
    // to the user's default browser and activates it. MEASURED — a run asked to
    // use Chrome ran `open chrome://new-tab`, which put a browser in front of
    // the user for the rest of the run. Same shape as `open -a`: right intent, wrong
    // verb, and there is a command that does it properly.
    '    [a-z]*://*) url="$arg"; flagged=1 ;;',
    '    --application=*) app="${arg#--application=}"; flagged=1 ;;',
    '    -a?*) app="${arg#-a}"; flagged=1 ;;',
    '    -a|--application) flagged=1 ;;',
    '    -b) flagged=1 ;;',
    '  esac',
    '  prev="$arg"',
    'done',
    /*
     * AND A BARE PATH TAKES THE SCREEN TOO.
     *
     * REPORTED by the user, twice, with no run in flight: "finder keeps on opening
     * up to exactly /Users/user/Desktop/OSS-harness/packages/harness". That is
     * pi's own cwd, which means the line was `open .` — the most natural thing a
     * model types when it wants to look inside a folder, and the one form
     * guaranteed to put a Finder window in front of the user. It fell straight
     * through to /usr/bin/open here because only -a and URLs were flagged.
     *
     * A folder HAS a true equivalent — `ls` answers "what is in here" without a
     * window — so translate it, the same as `open -a`. A regular file does not:
     * the honest answer is the read tool, which is a normal tool call rather
     * than a command on this PATH, so say that instead of exec'ing a guess.
     */
    'if [ -z "$app$url$bundle" ]; then',
    '  target=""',
    '  for arg in "$@"; do',
    '    case "$arg" in',
    '      -*) ;;',
    '      *) [ -n "$target" ] || target="$arg" ;;',
    '    esac',
    '  done',
    /* `open -n "Google Chrome"` names an APP, not a path — /usr/bin/open would
       fail with "does not exist", and the model would try again with a form that
       does take the screen. If an app by that name is installed, this is the
       same intent as `open -a` and gets the same translation. */
    '  if [ -n "$target" ] && [ -d "/Applications/$target.app" ]; then',
    '    app="$target"',
    '    flagged=1',
    '  elif [ -d "$target" ]; then',
    '    echo "open <folder> opens a Finder window in front of the user. Listing it instead (ls -la)." >&2',
    '    exec ls -la "$target"',
    '  elif [ -e "$target" ]; then',
    '    echo "open <file> hands the file to a GUI app and brings that app to the front, taking the screen from the user. Use the read tool on "$target" — it is a normal tool, not a command — or act on the file with the shell." >&2',
    '    exit 1',
    '  fi',
    '  [ -n "$flagged" ] || exec /usr/bin/open "$@"',
    'fi',
    // The translation. `mac` is on the same PATH this wrapper is on, so a plain
    // name resolves; guarded anyway, because a wrapper that exec's something
    // missing is a worse failure than the refusal it replaced.
    // The URL form, translated the same way and for the same reason.
    'if [ -n "$url" ] && command -v browser >/dev/null 2>&1; then',
    '  echo "open <url> hands the page to another browser and brings it to the front. Opening it in the app own browser instead (browser navigate). For the user OWN Chrome: mac chrome go --url \\"$url\\"" >&2',
    /*
     * …AND SAY WHAT TO DO WITH THE PAGE NOW THAT IT IS OPEN.
     *
     * The app-launch branch below shows the whole toolkit after redirecting, for
     * exactly this reason. The URL branch did not, so a model that asked for a
     * page got it opened and no idea how to READ it. MEASURED, MiniCPM5: after
     * this redirect it spent eleven calls on the `read` tool — directories, the
     * URL itself, and `read --help` passed as a PATH four times — because
     * nothing had told it `browser read` exists.
     *
     * Not `exec`, so the help follows the navigation's own output: what the
     * model reads is "the page is open, and here is how to look at it".
     */
    '  browser navigate --url "$url"',
    '  echo "" >&2',
    '  echo "That page is open in this app\'s browser. It is best read and driven with the commands below — browser read for the text, browser snapshot for the elements." >&2',
    '  browser --help 2>&1 | sed "s/^/  /" >&2',
    '  exit 0',
    'fi',
    'if [ -n "$app" ] && command -v mac >/dev/null 2>&1; then',
    '  echo "open -a would take the screen; opening \\"$app\\" in the background instead (mac launch)." >&2',
    /*
     * ...AND THEN SHOW IT THE WHOLE TOOLKIT.
     *
     * the user: "always ... after a terminal command for 'open -a' anything or just
     * that open command give a tidbit as if it ran mac --help give the full
     * thing and tell it 'this app is best controlled with the cli tools above'.
     * that should bias it away from writing these files and attempting to do
     * this directly."
     *
     * This is the moment a model has just demonstrated it is reaching for an app
     * with the wrong verb, and MEASURED it is also the moment it goes wrong
     * next: asked for Maps, models wrote `/tmp/maps_search.txt` seven times,
     * `pkill -9 Maps`, and an AppleScript file. They had the commands and no
     * reason to believe they were the answer.
     *
     * Not `exec`, so the help follows the launch's own output — the result it
     * reads is "the app is open, and here is everything you can do to it".
     */
    '  mac launch --app "$app"',
    '  status=$?',
    '  echo ""',
    '  mac --help 2>/dev/null',
    '  echo ""',
    '  echo "This app is best controlled with the commands above — look at it with' +
      ' \\`mac snapshot\\`, then act on what it lists. Do not write files or AppleScript to' +
      ' drive it; these commands ARE the way to drive it."',
    '  exit $status',
    'fi',
    "    echo 'open with that flag brings the app to the FRONT and takes the screen away from the user.' >&2",
    '[ -n "$app" ] || app="${bundle:-the app}"',
    '    echo "Use: mac launch --app \\"$app\\" — it opens $app in the BACKGROUND and hands you back its window to act on. Then mac snapshot --app \\"$app\\" to see its controls. Running open -a again, quoted differently, will not work." >&2',
    'exit 127',
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of shell script
    '',
  ].join('\n');
}

/**
 * How long a command may take before the shim gives up.
 *
 * MUST EXCEED THE BASH TOOL'S OWN TIMEOUT, or the shim reports failure for work
 * the harness is still doing. It was 120s against a bash tool that allows 300s,
 * and on-device generation lives in between — a 512px TRELLIS render measures
 * ~225s. The model was told its command FAILED while the job ran to completion
 * and wrote its result into a closed socket, which is about the strongest
 * argument a model could be given for doing the job by hand next time.
 *
 * The harness passes its real bash timeout in, so the two cannot drift apart.
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000;

/**
 * The dispatcher: argv → socket → text on stdout.
 *
 * Written as source rather than shipped as a file because it has to live beside
 * the shims in the temp dir the shims point at, and because it must not depend
 * on anything in the app bundle's module graph.
 */
export function buildDispatcherSource(timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS): string {
  return `
const net = require('node:net');
const sock = process.env['${TOOL_CLI_SOCK_ENV}'];
const token = process.env['${TOOL_CLI_TOKEN_ENV}'];
const argv = process.argv.slice(2);
if (!sock) { console.error('tool bridge not available in this shell'); process.exit(2); }
const c = net.createConnection(sock);
let buf = '';
const timer = setTimeout(() => { console.error('tool bridge timed out'); process.exit(3); }, ${timeoutMs});
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
  fs.writeFileSync(
    dispatcherPath,
    buildDispatcherSource(opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS),
    'utf8',
  );

  /*
   * A shim per capability group — named from the GROUPS ALONE, never from the
   * registry.
   *
   * This used to call `host.tools()` here to drop groups whose tools this build
   * does not register. That was a nicety and it cost the whole extension:
   * `pi.getAllTools()` is an action method, install runs during `activate()`,
   * and pi answers action methods at load time by refusing to load the
   * extension at all — "Extension runtime not initialized". The harness then
   * never registered anything, every hook it owns went with it, and the app
   * reported `write EPIPE` on the next message because the child was gone.
   *
   * Nothing is lost. `dispatchToolCli` rebuilds the surface from the live
   * registry on every request, where the call is legal, so a group with no
   * registered tools answers "no such command" from its own shim instead of
   * being absent — the same information, one process later.
   */
  const commands = toolCliShimCommands(host.groups());

  /*
   * SIGNPOSTS WHERE THE MODEL ACTUALLY GOES WRONG.
   *
   * MEASURED in the app, with `bash` as the only tool: asked for a picture, the
   * model wrote its own PNG and opened it in Photos; asked for a door slam, it
   * synthesised "a 0.1-second sharp noise with exponential decay". It never ran
   * `media`. The preamble tells it not to do this and the preamble is not
   * enough, because a CLI mode hands the model a REAL Unix box — and a real Unix
   * box is a competing implementation of every capability we offer. In the
   * offline eval this failed loudly (no ffmpeg, so it refused); on a machine
   * that HAS ffmpeg it succeeds badly, which is worse.
   *
   * So the temptations answer for themselves, at the moment of the mistake,
   * which is a far stronger signal than an instruction issued a thousand tokens
   * earlier. Deliberately narrow: media tools only. `python` and `node` are not
   * shimmed — they have real work to do here, and a shell that lies about its
   * own contents would break every legitimate use.
   */
  const DECOYS: Readonly<Record<string, string>> = {
    /*
     * ONLY WHERE THERE IS SOMEWHERE TO GO.
     *
     * This list used to include ffmpeg, ffplay, sox, afplay, convert and
     * magick, all pointing at `media`. There is no transcode, trim, concat or
     * resize command in any registry — so a legitimate ffmpeg job was not
     * redirected, it was made impossible, and the "use media instead" message
     * was a signpost pointing at nothing. That is worse than the dead end it
     * replaced: the model at least knew what a missing binary meant.
     *
     * What is left is the exact mappings — a text-to-speech binary really does
     * have `media generate speech` as its equivalent, so the redirect is true.
     * The moment a transcode command exists, ffmpeg belongs back here.
     */
    say: 'media generate speech',
    espeak: 'media generate speech',
    festival: 'media generate speech',
  };
  for (const command of commands) {
    const p = path.join(shimDir, command);
    fs.writeFileSync(p, buildShim(execPath, dispatcherPath, command), { mode: 0o755 });
  }
  // `open` is wrapped, not shadowed: only the form that steals the screen is
  // redirected (see buildOpenWrapper).
  fs.writeFileSync(path.join(shimDir, 'open'), buildOpenWrapper(), { mode: 0o755 });
  for (const [decoy, suggestion] of Object.entries(DECOYS)) {
    // Only where a real command of that name is not already the point — these
    // sit FIRST on PATH, so they shadow the system one for this session only.
    fs.writeFileSync(path.join(shimDir, decoy), buildDecoy(decoy, suggestion), { mode: 0o755 });
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
/**
 * Tools whose result is CONTENT, not guidance.
 *
 * Everything else a tool says is authored prose written for schemas mode, and
 * retargeting it is the point (below). These return a file, a directory or a
 * command's output verbatim, and rewriting a token inside someone's file would
 * be corruption — a source file that happens to mention `mac_click` must reach
 * the model exactly as it is on disk.
 */
const VERBATIM_RESULT_TOOLS = new Set(['read', 'ls', 'bash', 'python_run', 'web_fetch']);

/**
 * Route one request.
 *
 * The CLI is rebuilt from the registry per request rather than captured at
 * install time: an extension that registers a tool later in the session should
 * be reachable without restarting the shell, and a tool that went away should
 * stop being listed rather than answering "unknown".
 *
 * RESULTS SPEAK COMMANDS TOO.
 *
 * The system prompt was taught to name commands instead of tools; tool RESULTS
 * were not, and they are full of authored guidance written for schemas mode.
 * MEASURED, the Calculator run: `mac launch` came back with a perfect indexed
 * snapshot and the sentence "All mac_* actions now target it automatically" —
 * naming a thing that is not on the PATH. The model had the app open, the
 * controls listed, and no runnable next step, so it went off to edit a
 * preferences file instead. A snapshot the model cannot act on is not a
 * snapshot.
 *
 * One rewrite here covers every tool, which is the only way this stays true: 48
 * of these names are spread across the mac tools alone, and the next tool to be
 * written will have its own.
 */
export async function dispatchToolCli(
  host: ToolCliHost,
  argv: readonly string[],
): Promise<{ text: string; isError: boolean }> {
  const cli: CliModel = buildCli(host.groups(), host.tools());
  const res = resolveCli(cli, argv);
  const speakCommands = (text: string, tool?: string): string => {
    if (tool !== undefined && VERBATIM_RESULT_TOOLS.has(tool)) return text;
    const commandFor = new Map<string, string>();
    for (const g of cli.groups) {
      for (const c of g.commands) commandFor.set(c.tool.name, [g.name, ...c.path].join(' '));
    }
    return retargetToolNames(text, commandFor);
  };
  if (res.kind === 'text') return { text: speakCommands(res.text), isError: false };
  if (res.kind === 'error') return { text: speakCommands(res.text), isError: true };
  try {
    const r = await host.call(res.tool, res.args);
    return { ...r, text: speakCommands(r.text, res.tool) };
  } catch (e) {
    return {
      text: speakCommands(`${res.tool}: ${e instanceof Error ? e.message : String(e)}`, res.tool),
      isError: true,
    };
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
