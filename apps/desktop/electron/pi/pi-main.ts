/**
 * Main-process pi wiring: one PiBridge child per window (WebContents), every
 * bridge event multiplexed to that window over the shared event wire.
 *
 * The engine never imports electron; session lifecycle/handler logic lives in
 * the electron-free ./pi-sessions module, and this module is the seam where
 * Electron specifics (app path, ipcMain, webContents) are injected.
 */

import { readFileSync } from 'node:fs';
import type { PiBridgeEvent } from '@pi-desktop/engine';
import { PiBridge } from '@pi-desktop/engine/main';
// The NAME-ONLY subpath, not the barrel. Importing `@pi-desktop/harness` here
// drags the whole extension — and pi-coding-agent with it — into this CJS main
// bundle, where an ESM-only package compiles to `require()` and hangs boot with
// no window and no visible error. Same trap `loadPi` documents; this module is
// dependency-free for exactly this reason.
import { FORBID_TOOLS_ENV } from '@pi-desktop/harness/permissions/forbidden';
import { MESSAGES_SEND_TOOL } from '@pi-desktop/mac-connectors/tool-names';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { guardRun } from '../gen/guardian-main';
import { openStillWindow } from '../gen/hyperframes-window';
import { omniSvgFiles } from '../gen/omnisvg';
import { registerGen3dBridge } from '../gen3d/gen3d-bridge';
import { model3dReady, run3dJob, runImageJob, runStage3dJob } from '../gen3d/gen3d-main';
import { detectHarnesses } from '../inference/harness-main';
import {
  getInferenceUtility,
  getInferenceVisionReady,
  utilityStateFilePath,
  visionStateFilePath,
} from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { releaseMacBrake } from '../mac/mac-agent';
import { officeGenEnv, primeOfficeGen } from '../office/office-gen-env';
import {
  activeProjectFullAccess,
  activeProjectPath,
  currentWorkspaceDir,
} from '../project/project-main';
import { resolveSessionCwd } from '../sandbox';
import {
  advancedSamplingFilePath,
  generationExperimentEnabled,
  readSettings,
} from '../settings/settings-main';
import { isTrustedIpcEvent } from '../trusted-senders';
import { type ChildAgents, createChildAgents } from './child-agents';
import type { PiInvokeMap } from './contract';
import { extensionPackageDirs, toolExtensionPackageDirs } from './extension-dirs';
import { createPiSessions, type PiSessionHandlers } from './pi-sessions';
import { registerPrefillIpc } from './prefill-main';
import { registerPresentBridge } from './present-bridge';
import { installPiQuitHold } from './quit-hold';
import { registerResumeIpc } from './resume-main';
import { registerSubagentBridge } from './subagent-bridge';

/**
 * The pi binary the user chose, or undefined for the bundled one.
 *
 * `pi-system` deliberately resolves through the SAME search as harness
 * detection rather than bare `pi`: a GUI app inherits launchd's PATH, so a bare
 * name fails for exactly the user who has pi installed and working.
 */
function harnessBinPath(): string | undefined {
  try {
    const s = readSettings();
    if (s.harnessId === 'pi-system') {
      const found = detectHarnesses([{ id: 'pi-system', bin: 'pi' }])[0];
      return found?.installed === true ? found.path : undefined;
    }
    // pi-custom points at a CONFIG, not a binary: the bundled pi still runs, it
    // just reads the user's config. Handled via args, not binPath.
    return undefined;
  } catch {
    return undefined;
  }
}

const log = createLogger('desktop:pi');
const events = createIpcEventSender<AppEventMap>();

/**
 * The bundled pi extension packages, loaded via repeated `-e` flags. The list is
 * built by the pure {@link extensionPackageDirs} helper: always-on providers +
 * tools (provider-llamacpp/afm/mlx, harness, web-tools, browser-use,
 * mac-connectors, mac-computer-use, mcp-lite), PLUS the `gen-tools` generation
 * tools ONLY when the EXPERIMENTAL generation flag / `PI_DESKTOP_GEN=1` is on —
 * so a default build never exposes the generation tools. Each dir is resolved to
 * its `<pkg>/src/index.ts` — repo-relative in dev, bundle-relative (in the asar)
 * when packaged — and only those that actually `export default` an activate are
 * included, so an absent/placeholder extension is tolerated and lands
 * automatically once its workstream ships.
 *
 * The flag is read once at module load (whenReady). A mid-session toggle applies
 * on the NEXT app launch — matching how an experimental extension-loading flag
 * behaves (the dev `PI_DESKTOP_GEN=1` override is the immediate path).
 */
const EXTENSION_PACKAGE_DIRS = extensionPackageDirs(generationExperimentEnabled());

function resolveExtensionPaths(): string[] {
  const out: string[] = [];
  for (const pkgDir of EXTENSION_PACKAGE_DIRS) {
    const abs = resolveBundledPackageAsset(pkgDir, 'src/index.ts');
    try {
      if (/export\s+default/.test(readFileSync(abs, 'utf8'))) out.push(abs);
    } catch {
      // Absent — tolerated; the workstream building it hasn't shipped yet.
    }
  }
  log.info('pi extensions resolved', { count: out.length, paths: out, packaged: app.isPackaged });
  return out;
}

const EXTENSION_PATHS: string[] = resolveExtensionPaths();

/**
 * The TOOL extension paths (no providers) — the same surface the chat loads,
 * exported so a corp role's session can load exactly it.
 *
 * Resolved lazily and cached: this module's top-level resolve already ran for the
 * child's `-e` flags, and repeating the file reads per role would be waste.
 */
let toolExtensionPaths: string[] | undefined;
export function piToolExtensionPaths(): string[] {
  if (toolExtensionPaths !== undefined) return toolExtensionPaths;
  const wanted = new Set(
    toolExtensionPackageDirs(generationExperimentEnabled()).map((d) =>
      resolveBundledPackageAsset(d, 'src/index.ts'),
    ),
  );
  // Reuse the already-verified list, so a placeholder extension stays excluded.
  toolExtensionPaths = EXTENSION_PATHS.filter((p) => wanted.has(p));
  log.info('corp role tool extensions', { count: toolExtensionPaths.length });
  return toolExtensionPaths;
}

/** SIGTERM → SIGKILL grace for every bridge; the quit hold caps at this plus
 * a margin, so the two must not drift apart. */
const KILL_GRACE_MS = 1500;

/**
 * Env for the pi child, augmented (task #54) with the harness reliability
 * engine's utility endpoint when a local model server is running at spawn — so
 * the fixer / reviewer / adversarial / classifier-escalation actually fire,
 * pointed at the SAME local server pi uses. Read fresh on every spawn: a model
 * switch respawns pi (local-model.ts → restartPi), so a server that comes up
 * later is picked up on the next spawn. If no server is up, the vars are left
 * unset and the harness degrades to its heuristic fallback (never a hardcoded
 * URL). Dynamic gap: a server that starts WITHOUT a subsequent pi respawn won't
 * re-point the already-running child until the next spawn.
 */
function buildPiEnv(cwd: string | undefined): Record<string, string | undefined> {
  const utility = getInferenceUtility();
  // Whether the server this child will talk to can SEE. Read by the provider so
  // an image is never sent to a text-only server as undecodable tokens.
  const vision = getInferenceVisionReady() ? '1' : '0';
  return {
    ...process.env,
    // File-spill containment (blind-test round-2 #2): turn ON the harness's
    // sandbox-fenced write/edit/read/ls override (packages/harness sandbox-fs.ts)
    // for every desktop-spawned pi, and hand it the resolved sandbox/project cwd
    // so a RELATIVE path the model writes lands there — never HOME. Set even when
    // `cwd` is undefined (a resumed session restores its own cwd; the override
    // falls back to pi's per-session ctx.cwd, still never HOME).
    /*
     * …UNLESS THE USER ASKED FOR FULL ACCESS. the user: "in projects, add a 'full
     * access' mode — red, with an ! in a circle — that gives the model full
     * reign and full access … no sandboxing." Off by default and per project,
     * so it applies only to the folder it was deliberately switched on for; the
     * composer shows a red warning for as long as it is on. Read at SPAWN, which
     * is why the renderer restarts pi when it is flipped.
     */
    PI_DESKTOP_FS_FENCE: activeProjectFullAccess() ? '0' : '1',
    // The sampling-override sidecar the provider's advanced-params hook reads for
    // live per-request sampling (power-user panel). Pointing at a stable path;
    // the file may not exist yet (default profile) — the hook no-ops then.
    PI_ADV_SAMPLING_FILE: advancedSamplingFilePath(),
    PI_DESKTOP_VISION: vision,
    /*
     * THE TOOL INTERFACE. '1' turns on the user's bash-CLI experiment: the harness
     * advertises `bash` and little else, installs a shim per capability group on
     * PATH, and puts the command list in the system prompt. Default is off, so
     * this is '0' unless the Harness settings panel says otherwise.
     */
    PI_DESKTOP_TOOL_CLI: readSettings().toolInterface === 'bash-cli' ? '1' : '0',
    /* Which gen-tools register: the media tools only under the experiment, and
       `svg` only once the OmniSVG connector's model is on disk — a command that
       can only fail costs prompt and invites a dead end. Read at spawn; the
       connector install restarts pi so the change is live at once. */
    PI_DESKTOP_GEN_MEDIA: generationExperimentEnabled() ? '1' : '0',
    PI_OMNISVG_READY: omniSvgFiles().ready ? '1' : '0',
    /* The 3D connector's tools: only once an engine that can make a mesh is on
       this machine AND the connector is on (Connectors → Bobble 3D). the user
       (2026-09-17): "3d should be a connector that gets recommended for
       install upon installing the 3d studio module". */
    PI_BOBBLE_3D_READY:
      model3dReady() && readSettings().moduleConnectors['3d'] === true ? '1' : '0',
    /* The document pipeline — where `office.py` is, a Python that has its
       libraries, and a scratch dir — so the harness's `office` tool registers
       and runs in every chat, not only inside a corp run. See office-gen-env.ts. */
    ...officeGenEnv(),
    // …and the live file, which children re-read. The env value above is a
    // spawn-time snapshot and a subagent outlives it — see serverCanSeeImages.
    PI_DESKTOP_VISION_FILE: visionStateFilePath(),
    ...(cwd !== undefined ? { PI_DESKTOP_WORKSPACE_ROOT: cwd } : {}),
    ...(utility !== null
      ? { PI_DESKTOP_UTILITY_BASE_URL: utility.baseUrl, PI_DESKTOP_UTILITY_MODEL: utility.model }
      : {}),
    // …and the LIVE file, always. The env pair above is a spawn-time snapshot and
    // on app open pi starts BEFORE the server, so without this the harness never
    // learns there is an endpoint at all — which is what kept the system-prompt
    // warm-up from ever running outside a probe.
    PI_DESKTOP_UTILITY_FILE: utilityStateFilePath(),
  };
}

const sessions = createPiSessions<WebContents>({
  createBridge: (req, onEvent, opts) => {
    // No project/working-folder + no session to resume → root this conversation
    // at its dedicated `~/.pi/desktop/sandbox/<id>/` sandbox (created on demand)
    // rather than letting pi fall back to HOME. An explicit project cwd still
    // wins; resuming a session defers to its recorded cwd. See electron/sandbox.ts.
    // Also published to the pi child (buildPiEnv) as PI_DESKTOP_WORKSPACE_ROOT so
    // the harness file-tool override roots relative writes here, not HOME (#2).
    // Root EVERY spawn at the active project when one is selected: a resume /
    // model-switch respawn carries no explicit cwd, so without this the session's
    // stale recorded cwd (the sandbox) wins and bash/file ops silently leave the
    // project. An explicit request cwd (a fresh start already carrying the project)
    // still takes precedence.
    const cwd = resolveSessionCwd({ ...req, cwd: req.cwd ?? activeProjectPath() ?? undefined });
    const bridge = new PiBridge(
      {
        cwd,
        sessionPath: req.sessionPath,
        env: buildPiEnv(cwd),
        // Extensions are skipped on a post-crash retry (a broken/WIP extension
        // that exits pi at startup degrades to a working extension-free session).
        extensionPaths: opts?.extensionsDisabled === true ? [] : EXTENSION_PATHS,
        // Load ONLY our bundled `-e` extensions; never pi's auto-discovered
        // `~/.pi/agent/extensions/*.ts` (and `<cwd>/.pi/extensions`). A stale
        // user copy of any tool (e.g. web-tools.ts) there registers a duplicate
        // tool name → pi exits 1 at startup → the self-heal respawns
        // extension-free, which leaves models.json's `llamacpp-stream` api
        // UNHANDLED and dead-ends chat. `--no-extensions` (pi 0.68.1) disables
        // discovery only; explicit `-e` paths still load, so this guarantees the
        // primary path and makes the extension-free respawn a true last resort.
        //
        // `--no-skills`: SAME discipline for skills. pi auto-discovers
        // `~/.pi/agent/skills/*` and injects an `<available_skills>` catalog into
        // EVERY turn's system prompt. That leaks a user's UNRELATED global skills
        // (the user saw `coding` / `isaac` / `plan` / `unity` from other projects) into
        // this app's chat — bloat the app never asked for, and skills aren't a
        // designed feature here yet. Off until we surface a curated set from our
        // own bundled dir on purpose.
        extraArgs: ['--no-extensions', '--no-skills'],
        killGraceMs: KILL_GRACE_MS,
        // Spawn pi as its own process-group leader so quit/dispose reaps its
        // subagent grandchildren too, not just the direct child (task #55): a
        // hard-kill otherwise strands orphaned subagent pi processes.
        detached: true,
        /*
         * WHICH pi (Settings -> Harness). `binPath` wins over PI_BIN and over
         * the bundled CLI inside resolvePiSpawn, so setting it is the whole of
         * "use a different pi" — no separate spawn path, no second code route
         * that could drift from the bundled one.
         *
         * Resolved fresh on every bridge construction rather than captured at
         * module load, so switching harness and starting a new chat picks the
         * new binary up without a relaunch.
         */
        binPath: harnessBinPath(),
        // Bundled resolution root; PI_BIN (E2E/mock) and explicit binPath
        // still take precedence inside the engine.
        appRoot: app.getAppPath(),
      },
      onEvent,
    );
    /*
     * UNDER THE MEMORY GUARD, lightly. A pi child and whatever its tools spawn
     * (a script the model wrote, a build) are paused with the heavy runs when
     * the machine is tight and never terminated by the guard — their memory
     * is the model server's, which is parked on its own. `light`: a chat
     * alone does not put the guard on its fast cadence.
     */
    const off = guardRun({
      id: `pi:${bridge.pid}`,
      label: 'the chat',
      kind: 'agent',
      light: true,
      neverTerminate: true,
      pid: () => (bridge.alive ? bridge.pid : undefined),
    });
    void bridge.whenExited().then(off, off);
    return bridge;
  },
  sendEvent: (sender, event) => events.send(sender, 'pi:event', event),
  sendVisionWanted: (sender) => events.send(sender, 'llm:vision-wanted', {}),
  // The person asking again is what releases a latched Stop / take-over.
  onUserPrompt: () => releaseMacBrake(),
  sendExtensionsDisabled: (sender, reason) =>
    events.send(sender, 'pi:extensions-disabled', { reason }),
  log,
});

/**
 * Build an app-owned CHILD pi instance (a subagent / role as its own first-class
 * `pi --mode rpc`, driven by the app exactly like the main chat). Same base
 * config as the main bridge, but a fresh `--no-session` and a bumped subagent
 * depth so the child's own harness won't register spawn_subagent — no runaway
 * recursion of children spawning children.
 */
function createChildBridge(
  opts: { cwd?: string; specialist?: string; agentId?: string },
  onEvent: (event: PiBridgeEvent) => void,
): PiBridge {
  /*
   * A CHILD INHERITS THE CHAT'S WORKSPACE. Without `currentWorkspaceDir()` this
   * had no cwd and no conversationId whenever no project was selected, so every
   * subagent and corp role landed in the shared sandbox `default` — a different
   * directory from the chat that spawned it.
   */
  const cwd = resolveSessionCwd({
    cwd: opts.cwd ?? currentWorkspaceDir() ?? activeProjectPath() ?? undefined,
  });
  return new PiBridge(
    {
      cwd,
      env: {
        ...buildPiEnv(cwd),
        // Matches SUBAGENT_DEPTH_ENV (packages/harness subagent/types.ts): a child
        // at depth >= 1 does NOT register the spawn tool.
        PI_DESKTOP_SUBAGENT_DEPTH: '1',
        /*
         * WHO IS ASKING, on every job this child starts (gen-tools' GEN_AGENT_ENV).
         * The renderer maps it back to the chat that owns the child, so deleting
         * that chat stops the picture, the clip or the mesh it was making.
         */
        ...(opts.agentId !== undefined ? { PI_DESKTOP_AGENT_ID: opts.agentId } : {}),
        /*
         * A SPECIALIST CHILD IS PINNED TO ITS OWN TOOLS. the user: "with just these
         * tools loaded, those subagents are only for that purpose, we aren't
         * putting any of this as 'capability suites'." The child's harness reads
         * this and REPLACES its preset with exactly that role's kit — no
         * activation step, nothing else reachable. Keyed to SPECIALIST_ENV in
         * packages/harness subagent/specialist-env.ts.
         */
        ...(opts.specialist !== undefined ? { PI_DESKTOP_SPECIALIST: opts.specialist } : {}),
        /*
         * A CHILD'S TOOL INTERFACE IS ITS OWN SETTING. the user: "ensure there is
         * a cli connector for the specialists that is by default there and
         * enabled, cli tools are a good context saver". The chat may run
         * schemas; a specialist running one pinned job takes the CLI (the
         * default) and pays a fraction of the prompt for the same reach —
         * `cliVisibleTools` narrows the commands to its kit, and the harness's
         * coverage test guarantees every tool it may hold has a command.
         */
        PI_DESKTOP_TOOL_CLI: readSettings().specialistToolInterface === 'bash-cli' ? '1' : '0',
      },
      noSession: true,
      extensionPaths: EXTENSION_PATHS,
      extraArgs: ['--no-extensions', '--no-skills'],
      killGraceMs: KILL_GRACE_MS,
      detached: true,
      appRoot: app.getAppPath(),
    },
    onEvent,
  );
}

/**
 * A bridge for a HEADLESS SCHEDULED RUN.
 *
 * Unlike `createChildBridge`, this is a TOP-LEVEL agent: no subagent-depth bump,
 * so a scheduled run can delegate to specialists exactly as a normal chat can —
 * "make me a news video and a portrait" may well want the video and image
 * specialists. It is still sessionless (`noSession`), so it never writes a
 * session JSONL and thus never appears in the sidebar; the run's trace lives in
 * its own run record instead (scheduled-runner.ts).
 *
 * Full base config — same extensions and env as the main chat — because a
 * scheduled run must be able to do anything the user could do by hand.
 */
/**
 * What a scheduled run may never call.
 *
 * `messages_send` is the only tool in the app that puts something in front of
 * another person. Creating a calendar event or a reminder is deliberately NOT
 * here — "remind me to…" is a thing people want a scheduled task to do, and it
 * only ever writes to the user's own devices.
 */
const SCHEDULED_FORBIDDEN_TOOLS = [MESSAGES_SEND_TOOL] as const;

export function createScheduledRunBridge(
  opts: { cwd?: string },
  onEvent: (event: PiBridgeEvent) => void,
): PiBridge {
  const cwd = resolveSessionCwd({
    cwd: opts.cwd ?? currentWorkspaceDir() ?? activeProjectPath() ?? undefined,
  });
  return new PiBridge(
    {
      cwd,
      /*
       * NOTHING GOES OUT FROM AN UNATTENDED RUN.
       *
       * A scheduled task runs at 07:30 with nobody watching. Reading the user's
       * mail and calendar to write them a brief is the whole point; sending a
       * message on their behalf while they are asleep is not, and a prompt
       * saying "do not send" is a request, not a fence. The harness blocks these
       * at `tool_call`, the one place every dispatch path passes through — an
       * advertised call, `use`, or a bash-CLI command.
       */
      env: {
        ...buildPiEnv(cwd),
        [FORBID_TOOLS_ENV]: SCHEDULED_FORBIDDEN_TOOLS.join(','),
      },
      noSession: true,
      extensionPaths: EXTENSION_PATHS,
      extraArgs: ['--no-extensions', '--no-skills'],
      killGraceMs: KILL_GRACE_MS,
      detached: true,
      appRoot: app.getAppPath(),
    },
    onEvent,
  );
}

const childAgents: ChildAgents<WebContents> = createChildAgents<WebContents>({
  createChildBridge,
  sendChildEvent: (sender, msg) => events.send(sender, 'pi:child-event', msg),
  log,
});

/** Senders whose child-agent reap-on-destroy hook is already installed. */
const childReapHooked = new Set<number>();

/** Register the pi:child-* handlers (guarded like the main pi channels). A child
 * pi is exec-capable, so only trusted main frames may spawn/drive one; children
 * are reaped when their owning window is destroyed and in the quit hold. */
function registerChildAgentIpc(): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      log.warn('rejected child-agent invoke from untrusted sender', {
        channel,
        wcId: event.sender.id,
      });
      throw new Error(`[pi] rejected "${channel}": untrusted sender`);
    }
  };
  ipcMain.handle('pi:child-spawn', (event, req: PiInvokeMap['pi:child-spawn']['request']) => {
    guard(event, 'pi:child-spawn');
    const sender = event.sender;
    if (!childReapHooked.has(sender.id)) {
      childReapHooked.add(sender.id);
      sender.once('destroyed', () => {
        childAgents.disposeForSender(sender.id);
        childReapHooked.delete(sender.id);
      });
    }
    return childAgents.spawn(sender, req);
  });
  ipcMain.handle('pi:child-dispose', (event, req: PiInvokeMap['pi:child-dispose']['request']) => {
    guard(event, 'pi:child-dispose');
    return childAgents.disposeChild(req.childId);
  });
  ipcMain.handle('pi:child-list', (event) => {
    guard(event, 'pi:child-list');
    return { children: childAgents.list(event.sender.id) };
  });
}

/** Sender-aware variant of the shared register helper: pi channels route to a
 * per-window bridge, so handlers need event.sender. Exhaustive by type, and
 * gated on the trusted-sender registry — pi is an exec-capable agent, so only
 * main frames of app-created windows may reach a bridge. */
function registerAll(handlers: PiSessionHandlers<WebContents>): void {
  for (const [channel, handler] of Object.entries(handlers) as Array<
    [string, (sender: WebContents, request: unknown) => unknown]
  >) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, request: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel, wcId: event.sender.id });
        throw new Error(`[pi] rejected "${channel}": untrusted sender`);
      }
      return handler(event.sender, request);
    });
  }
}

/**
 * @param opts.extraTeardown Non-pi child processes to reap in the SAME held quit
 *   window as the pi bridges — the inference utilityProcess+llama-server, the
 *   pi-mac helper, and terminal PTYs. Composed in main.ts (the wiring root) and
 *   awaited (bounded by the quit grace) before `app.exit()`.
 */
export function registerPiIpc(
  opts: {
    extraTeardown?: () => Promise<void>;
    /** The app window subagents run under (spawn_subagent → app bridge). When
     * given, the subagent socket bridge stands up + publishes its env before the
     * first pi spawn, so the child's harness routes spawn_subagent to the app. */
    getWindow?: () => WebContents | null;
  } = {},
): void {
  registerAll(sessions.handlers);
  registerChildAgentIpc();
  registerResumeIpc();
  registerPrefillIpc();
  if (opts.getWindow !== undefined) registerSubagentBridge(opts.getWindow, childAgents);
  /*
   * `present` — the top-level model's last act. Its bridge shows the artefact in
   * the canvas AND renders a preview back to the model, so nothing can be handed
   * over unlooked-at. HTML is captured with the same offscreen window HyperFrames
   * uses; env must be live before the first pi spawn, like its siblings.
   */
  /* Find (or build) the interpreter the office pipeline runs on. Async and
     never awaited: the first pi spawn may see only the `python3` default, which
     is what the harness falls back to anyway. */
  void primeOfficeGen();
  if (opts.getWindow !== undefined) {
    registerPresentBridge({
      getWindow: opts.getWindow,
      renderPage: async (filePath) => {
        const win = await openStillWindow(1280, 900);
        try {
          await win.load(
            `<meta http-equiv="refresh" content="0; url=file://${filePath}">`,
            1280,
            900,
          );
          await new Promise((r) => setTimeout(r, 600));
          return (await win.capture()).toString('base64');
        } catch {
          return null;
        } finally {
          await win.dispose().catch(() => {});
        }
      },
    });
  }
  // The chat's image tools (`generate_image` / `edit_image`) reach the gen3d
  // engine through their own socket bridge, for the same reason and with the
  // same timing constraint as the subagent one: its env must be published
  // BEFORE the first pi spawn, or the harness sees no bridge and (by design)
  // never registers the tools.
  registerGen3dBridge(runImageJob, { generate: run3dJob, stage: runStage3dJob });

  installPiQuitHold(app, {
    // Reap child-agent pi instances in the same held quit window as the main
    // bridges, so no orphaned subagent/role pi processes leak on quit.
    bridges: () => [...sessions.bridges(), ...childAgents.bridges()],
    disposeAll: () => {
      sessions.disposeAll();
      childAgents.disposeAll();
    },
    graceMs: KILL_GRACE_MS,
    extraTeardown: opts.extraTeardown,
  });
}
