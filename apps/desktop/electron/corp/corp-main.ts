/**
 * Main-process wiring for the EXPERIMENTAL coordination harness (CorpEngine).
 *
 * A submitted prompt (flag on) starts a {@link CorpEngine} task here; the engine
 * runs the harness `runCorp` behind a REAL llama-server `/v1/chat/completions`
 * seam (the running local model, via `getInferenceUtility` / ensured with the
 * recommended Q8 qwen) and streams mapped {@link CoordinationEvent}s back to the
 * requesting window over `corp:event`. The renderer's situation room folds them.
 *
 * The CorpEngine + harness run ONLY here (Node/main); the renderer never imports
 * the engine — it drives it over these IPC channels and consumes the neutral DTOs.
 * Handlers are sender-aware (like pi-main) so a task's events route to the window
 * that started it, and trusted-sender gated (the harness is exec-capable via the
 * model — only main frames of app-created windows may reach it).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserAgentClient, registerBrowserUseTools } from '@pi-desktop/browser-use';
import type { CoordinationEvent, TaskHandle, TaskResult } from '@pi-desktop/coordination';
import { CorpEngine, createNodeWorkspaceFactory } from '@pi-desktop/coordination/corp';
import type { CorpChatFn } from '@pi-desktop/harness/corp';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type BrowserSearchFn, registerWebTools } from '@pi-desktop/web-tools';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { chatActivity } from '../activity/chat-activity';
import { ensureCorpInferenceServer } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { piToolExtensionPaths } from '../pi/pi-main';
import { currentWorkspaceDir } from '../project/project-main';
import type { EffortLevel } from '../settings/settings-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import { resolveProjectDir } from '../workspace/project-dir';
import { corpConcurrencyForHost } from './concurrency';
import { createLlamaCorpChat } from './corp-chat';
import type { CorpInvokeMap } from './corp-contract';
import { CORP_INVOKE_CHANNELS } from './corp-contract';
import { createBrowserSearch } from './corp-search';
import { openHierarchy } from './hierarchy-store';
import { listProject } from './mesh-host';
import { startMeshTask } from './mesh-run';
import { createCorpModelProvider } from './role-agent';
import { createRunRoleAgent } from './role-agent-seam-impl';
import { ensureTimeoutShim } from './timeout-shim';
import { deliveryFromTask } from './workspace-paths';

const log = createLogger('desktop:corp');
const events = createIpcEventSender<AppEventMap>();

/** Per-task record: the engine that owns it (absent for the env-gated agent-mesh
 * path, which has no CorpEngine), its handle, and the target window. */
interface RunningTask {
  readonly engine?: CorpEngine;
  readonly handle: TaskHandle;
  readonly wc: WebContents;
  /** Mesh runs have no CorpEngine — their cooperative stop lives here instead, so
   * `corp:abort` can halt a hierarchy the same way it aborts an engine task. */
  readonly abortMesh?: () => void;
  /**
   * The directory this run ACTUALLY resolved and wrote into.
   *
   * Recorded because the caller cannot re-derive it. `runCorpForBridge` used
   * `currentWorkspaceDir()`, module state that is only set once a workspace has
   * been resolved — and when it was null the failure report said "Nothing was
   * delivered" over 53 files. See the tree note in `runCorpForBridge`.
   */
  readonly cwd?: string;
}

const tasks = new Map<string, RunningTask>();

/**
 * Callers BLOCKED on a run's delivery, by taskId.
 *
 * `talk_to_manager` suspends the CEO until the team delivers (the user: "the ceo
 * should not get a tool result from the manager until the manager has run
 * everything and is ready to submit the whole working product"). The run itself
 * lives out here in main, so the waiter parks in this map and the event loop
 * that already drains the task's events releases it on `done`.
 */
const deliveries = new Map<string, (result: TaskResult | null) => void>();

function settleDelivery(taskId: string, result: TaskResult | null): void {
  const waiter = deliveries.get(taskId);
  if (waiter === undefined) return;
  deliveries.delete(taskId);
  waiter(result);
}

/** Stop a production — the composer's Stop, a deleted chat, or a CEO gone. */
function abortCorpRun(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (task === undefined) return false;
  // Mesh (hierarchy) runs have no engine — fire their cooperative stop instead,
  // so every subagent is told to wrap up and no new turns start.
  if (task.engine === undefined) {
    if (task.abortMesh === undefined) return false;
    task.abortMesh();
    return true;
  }
  task.engine.abort(task.handle);
  return true;
}

/** How many TERMINAL (done/errored) tasks to retain so the situation room + build
 * snapshot keep resolving after completion — `corp:peek`/`get-org-chart`/
 * `worker-transcript` read the on-disk product through the retained engine, and the
 * workspace is never cleaned up. Bounds memory across a long session (active tasks
 * are never pruned). Fixes the "Build snapshot: no files yet" on a COMPLETED run
 * whose files are on disk — the record was dropped the instant `done` fired. */
const RETAINED_TERMINAL_TASKS = 8;
const terminalOrder: string[] = [];

/** Where per-task workspaces land (a temp root; engineers write produced files
 * here). Isolated per task under the OS temp dir so a run never touches HOME. */
function corpWorkspaceRoot(): string {
  return path.join(app.getPath('temp'), 'pi-desktop-corp');
}

/**
 * Durably record a run's TERMINAL OUTCOME (the CEO verdict + timing) the moment it
 * lands — independent of the renderer. A run's result must survive the window
 * navigating away or closing: the `done` event is otherwise only forwarded to the
 * situation room, so if that view is gone the verdict is lost (and main.log never
 * had it). We write both a structured log line and a JSON sidecar in the workspace
 * ROOT (which outlives the per-task workspace that `terminate` cleans up).
 */
function recordCorpOutcome(taskId: string, result: TaskResult, elapsedMs: number): void {
  const record = {
    taskId,
    outcome: result.outcome,
    verdict: result.summary,
    error: result.error ?? null,
    elapsedMs,
    elapsedMin: Math.round((elapsedMs / 60_000) * 10) / 10,
  };
  log.info('corp task terminal outcome', record);
  try {
    fs.mkdirSync(corpWorkspaceRoot(), { recursive: true });
    fs.writeFileSync(
      path.join(corpWorkspaceRoot(), `outcome-${taskId}.json`),
      JSON.stringify(record, null, 2),
    );
  } catch (err) {
    log.warn('corp: failed to write outcome sidecar', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The model seam for a run: the running local server, ensured to the recommended
 * Q8 qwen (`-c 16384`). A model that cannot be found/started is SURFACED, not
 * hidden — the run terminates with an honest error rather than degrading to a
 * stub that appears to work but does nothing (a silent config-failure).
 */
type ResolvedCorpChat =
  | {
      readonly ok: true;
      readonly chat: CorpChatFn;
      readonly baseUrl: string;
      readonly model: string;
    }
  | { readonly ok: false; readonly message: string };

async function resolveCorpChat(parallel: number): Promise<ResolvedCorpChat> {
  const utility = await ensureCorpInferenceServer({ parallel });
  if (utility.ok) {
    log.info('corp chat bound to local server', { baseUrl: utility.baseUrl, model: utility.model });
    return {
      ok: true,
      chat: createLlamaCorpChat({ baseUrl: utility.baseUrl, model: utility.model }),
      baseUrl: utility.baseUrl,
      model: utility.model,
    };
  }
  log.warn('corp: no local model available — surfacing to the situation room', {
    modelId: utility.modelId,
    error: utility.error,
  });
  return {
    ok: false,
    message: `The model isn't available. Download ${utility.modelId} in Settings → Models to run the production harness.`,
  };
}

/** Placeholder model seam for the unavailable path — never invoked, because the
 * engine terminates via `startUnavailable` without running the harness. */
const noopCorpChat: CorpChatFn = () => ({ content: '' });

/**
 * Map the resolved effort slider level to the corp run's params (the effort gate).
 * Only the TOP TWO levels OFFER the corporation: 'max' → full decomposition ('max'),
 * 'high' → coarse ('xhigh'). 'low'/'medium' run a SINGLE capable solo agent (no
 * vision, no create_production_hierarchy). An absent effort (old client) preserves the
 * prior behavior — the corporation, coarse.
 */
function corpParamsForEffort(effort: EffortLevel | undefined): {
  promotionAllowed: boolean;
  decompositionGranularity: 'xhigh' | 'max';
} {
  if (effort === 'max') return { promotionAllowed: true, decompositionGranularity: 'max' };
  if (effort === 'low' || effort === 'medium') {
    return { promotionAllowed: false, decompositionGranularity: 'xhigh' };
  }
  // 'high' or undefined → the corporation, coarse decomposition.
  return { promotionAllowed: true, decompositionGranularity: 'xhigh' };
}

async function handleStart(
  wc: WebContents,
  req: CorpInvokeMap['corp:start']['request'],
): Promise<CorpInvokeMap['corp:start']['response']> {
  // Fan-out width. EMPIRICAL DEFAULT = SEQUENTIAL (K=1). On a single Apple GPU the
  // --parallel slots share one GPU, so concurrent engineers buy ~no aggregate
  // throughput (benchmarked ~72 tok/s single vs ~76 tok/s 3-concurrent) AND make each
  // turn ~3x slower. The OOM-safe RAM-fitted width (corpConcurrencyForHost) and the
  // whole parallel dispatch path stay tested for hardware where batching actually pays
  // (multi-GPU / servers); opt in with PI_DESKTOP_CORP_CONCURRENCY=<N> (OOM-capped).
  // KNOWN LIMITATION: the K>1 path currently has an unresolved hang in the engineer
  // seam under real concurrent model calls — diagnose before enabling in production.
  const basis = corpConcurrencyForHost();
  const requested = Number(process.env.PI_DESKTOP_CORP_CONCURRENCY);
  const parallelOptIn = Number.isFinite(requested) && requested >= 1;
  const concurrency = parallelOptIn ? Math.min(Math.floor(requested), basis.concurrency) : 1;
  log.info('corp concurrency selected', {
    concurrency,
    parallelOptIn,
    ramFittedMax: basis.concurrency,
    totalRamBytes: basis.totalRamBytes,
    perSlotKvBytes: basis.perSlotKvBytes,
  });
  const resolved = await resolveCorpChat(concurrency);
  // The ENGINEER role runs as a real agentic loop (file + bash tools) via the
  // role-agent seam, bound to the SAME resolved server the chat seam uses. Absent
  // on the unavailable path (the engine terminates without running the harness).
  // One shared bridge to the in-process browser-agent server (published on
  // app-ready). Drives the SAME visible canvas browser for both the browser_*
  // tools AND the browser-backed web_search below. Null in a headless/test main
  // (no bridge env) → web_search transparently falls back to the scrape.
  const browserBridge = BrowserAgentClient.fromEnv();
  // web_search, browser-backed: open the canvas browser to DuckDuckGo's HTML
  // results (the user watches it live) and scrape the hits via an in-page
  // evaluate — not bot-blocked the way the server-side scrape is (which returns
  // "No results"). H1: the scrape does NOT block on full page load (which hangs
  // ~tens of seconds after the server-rendered results are already in the DOM);
  // it caps the navigate wait, POLLS for the results container, then extracts
  // against the current `duckduckgo.com/html/` structure (see ./corp-search).
  const browserSearch: BrowserSearchFn | undefined =
    browserBridge === null ? undefined : createBrowserSearch(browserBridge);
  // EFFORT-GATED AGENT MESH: the top two effort levels (high/max) engage the
  // corporation — and at those levels it runs as a persistent multi-agent MESH
  // (The user's "everyone is an agent that talks to anyone"), emitting the SAME event
  // stream so the situation room renders it unchanged. Below high, there is no
  // delegation: the `else` branch runs a single solo agent (the deterministic path
  // with promotionAllowed=false). `corpParamsForEffort(effort).promotionAllowed` is
  // the same high/max gate the tool used.
  let engine: CorpEngine | undefined;
  let handle: TaskHandle;
  let abortMesh: (() => void) | undefined;

  /*
   * ONE ANSWER TO "WHERE DOES THE WORK GO", FOR BOTH BRANCHES.
   *
   * This lived inside the mesh branch only, so a team worked in the directory the
   * user named while a SOLO run — the same request, one effort level lower —
   * wrote into a random directory under the OS temp dir. Same product, same
   * question, two different answers, and the solo one produced exactly the
   * `/var/folders/4h/nq1c73.../T/...` paths the user has asked never to see again.
   *
   * The user, on the nested-folder symptom: "this nested folder stuff is also leading
   * me to belive you have conflicting systems." The user was right that there were two.
   * There is one now: the directory the task names, else the chat's folder, else
   * a per-task workspace as the last resort.
   */
  // A working `timeout` on PATH before any role gets a shell — four runs have
  // been wedged by one command that never returned.
  ensureTimeoutShim();
  const meshTaskId = `corp-mesh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  /*
   * THE DROPDOWN DECIDES. The user: "if they have a project selected that dropdown
   * right there is the end all be all ... always always always nothing competes
   * with that." `req.ctx.cwd` IS that selection; "No project" arrives as absent,
   * and becomes ~/Bobble/<conversation name>.
   *
   * This used to start from `workspaceFromTask(req.prompt)` — a regex over the
   * prompt prose — which OUTRANKED the user's own choice. That is where every
   * path bug came from, and each one failed silently: the team works perfectly
   * wherever it is put, so the only symptom is the chosen folder being empty.
   */
  /*
   * NEVER the prompt as a folder name. Falling back to `req.prompt` produced
   * `~/Bobble/build-a-small-command-line-todo-list-tool-in-python.-require` —
   * a sixty-character directory named after a sentence. The chat's title is the
   * name; absent one, the neutral placeholder is renamed when the title lands.
   */
  const projectPath = resolveProjectDir(
    req.ctx?.cwd,
    req.ctx?.conversationName ?? 'new chat',
    os.homedir(),
    req.ctx?.conversationId,
  );
  /*
   * A path NAMED IN THE PROMPT is a delivery destination, never a root. Writing
   * there is already permitted (`isNamedDestination`); the team is simply told
   * about it so the output lands where it was asked for.
   */
  const deliverTo = deliveryFromTask(req.prompt, os.homedir());

  if (resolved.ok && corpParamsForEffort(req.effort).promotionAllowed) {
    /*
     * THE TEAM BELONGS TO THE PROJECT, AND OUTLIVES THE RUN.
     *
     * This used to be a fresh randomly-named directory under the OS temp dir, so
     * the roster and every agent's conversation were written somewhere that had
     * never existed before and would be swept away — a brand-new team hired and
     * destroyed on every single run, with all the remembering machinery pointed
     * at nothing. The whole design rests on the opposite: come back to a project
     * next week and the person who wrote that code is still the one who fixes it.
     *
     * So the work happens in the CHAT'S OWN directory, and the team is stored in
     * the app, keyed to that directory's absolute path. Any chat opened on the
     * same project reaches the same hierarchy and therefore the same people, and
     * the user's folder stays free of machine transcripts they did not ask for.
     */
    /*
     * WORK WHERE THE USER SAID. A task that names a directory IS the instruction
     * about where the work goes, and rooting the team anywhere else guarantees
     * every relative shell command lands in the wrong tree — see
     * `workspaceFromTask`. Falls back to the chat's folder, then to a per-task
     * workspace, exactly as before.
     */
    const hierarchy = openHierarchy(app.getPath('userData'), projectPath);
    const cwd = projectPath;
    fs.mkdirSync(cwd, { recursive: true });
    log.info('corp MESH hierarchy', {
      project: hierarchy.projectPath,
      // TRACKABILITY: say where the work will land and why, once, in the log the
      // run is read from. "Where did the files go" has cost several runs.
      cwd,
      /*
       * WHY this directory. `ctx.cwd` arrives from two different places now —
       * the composer's folder dropdown, and the chat's already-resolved
       * workspace handed over by runCorpForBridge — so reporting both as
       * 'project-dropdown' made the log claim a selection that did not exist.
       * A diagnostic that misnames its own branch is worse than none.
       */
      cwdFrom:
        req.ctx?.cwd === undefined
          ? 'bobble-default'
          : req.ctx.cwd === currentWorkspaceDir()
            ? 'chat-workspace'
            : 'project-dropdown',
      deliverTo: deliverTo ?? '(none named)',
      team: hierarchy.dir,
      returning: hierarchy.existed,
    });
    const modelHandle = await createCorpModelProvider({
      baseUrl: resolved.baseUrl,
      model: resolved.model,
    });
    const meshHandle = startMeshTask({
      handle: modelHandle,
      task: req.prompt,
      taskId: meshTaskId,
      cwd,
      teamDir: hierarchy.dir,
      /*
       * THE TOOLS THE MESH ROLES WERE PROMISED. Their allowlists have always
       * named web_search / web_fetch, and now browser_*, but the mesh path wired
       * no factory behind any of them — so a manager told to "look it up" or to
       * open the product had names that resolved to nothing. These are the same
       * registrars the solo path uses, driving the same visible browser.
       */
      /*
       * THE SAME TOOLS THE CHAT HAS. Every role's session loads the app's own tool
       * extension packages — the harness, the MCP surface, the connectors,
       * generation when enabled — so a subagent is not a lesser kind of chat.
       * The web/browser registrars stay as FACTORIES because they carry live
       * in-process handles (the canvas browser bridge, the browser-backed search
       * fallback) that a package load cannot be given.
       */
      additionalExtensionPaths: piToolExtensionPaths(),
      extensionFactories: [
        (pi: never) => registerWebTools(pi, browserSearch !== undefined ? { browserSearch } : {}),
        (pi: never) => registerBrowserUseTools(pi, { bridge: browserBridge }),
      ],
    });
    handle = meshHandle;
    abortMesh = meshHandle.abort;
    log.info('corp MESH task started', { taskId: meshTaskId });
  } else {
    const runRoleAgent = resolved.ok
      ? createRunRoleAgent({
          baseUrl: resolved.baseUrl,
          model: resolved.model,
          // The CEO vision turn (spec §4) researches references — inject the web-tools
          // registrar so web_search / web_fetch exist for the runs whose allowlist
          // requests them (the seam gates by name; no other role is affected).
          // web_search is browser-backed when the bridge is present (see browserSearch).
          webResearchFactory: (pi) =>
            registerWebTools(pi, browserSearch !== undefined ? { browserSearch } : {}),
          // The browser_* tools drive the SAME visible canvas browser (the search
          // opens live in the situation-room canvas). Gated by name in the seam.
          browserToolsFactory: (pi) => registerBrowserUseTools(pi, { bridge: browserBridge }),
        })
      : undefined;
    engine = new CorpEngine({
      // Unused on the unavailable path (startUnavailable never calls the model).
      chat: resolved.ok ? resolved.chat : noopCorpChat,
      ...(runRoleAgent !== undefined ? { runRoleAgent } : {}),
      // The SAME directory the mesh would have used — see the note above the
      // branch. A solo run is still the user's work, in the user's folder.
      workspaceFor: createNodeWorkspaceFactory(projectPath),
      concurrency,
      ...corpParamsForEffort(req.effort),
    });
    handle = resolved.ok
      ? engine.startTask(req.prompt, req.ctx)
      : engine.startUnavailable(req.prompt, resolved.message, req.ctx);
  }
  tasks.set(handle.taskId, {
    ...(engine !== undefined ? { engine } : {}),
    ...(abortMesh !== undefined ? { abortMesh } : {}),
    handle,
    wc,
    /* `projectPath` is what `cwd` is set from in both branches — the directory
       the team actually writes into. Recorded so the hand-back can report what
       is on disk without re-deriving it from module state that may be unset. */
    cwd: projectPath,
  });

  // Forward the task's events to the requesting window until the terminal `done`.
  // We keep DRAINING to the terminal even if the window is gone (destroyed or
  // navigated away) so the outcome is always recorded — the harness run itself
  // proceeds in the main process regardless of who is watching.
  const startedAt = Date.now();
  // A corp run is the model in use until its stream ends (inference/idle-unload.ts).
  const endActivity = chatActivity.begin('subagent', `corp:${handle.taskId}`);
  void (async () => {
    try {
      for await (const event of handle.events) {
        if (event.type === 'done') {
          recordCorpOutcome(handle.taskId, event.result, Date.now() - startedAt);
          // Hand the delivered product to whoever is BLOCKED on this run — the
          // CEO's `talk_to_manager` call is suspended until this fires.
          settleDelivery(handle.taskId, event.result);
        }
        if (wc.isDestroyed()) continue;
        events.send(wc, 'corp:event', { taskId: handle.taskId, event: event as CoordinationEvent });
      }
    } catch (err) {
      log.warn('corp event stream errored', {
        taskId: handle.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      /*
       * A caller blocked on delivery must ALWAYS be released. If the stream ends
       * or throws without a `done`, resolving here is what stops the CEO waiting
       * forever on a run that is no longer going anywhere.
       */
      settleDelivery(handle.taskId, null);
      endActivity();
      // Do NOT drop the record on terminal — peek / org-chart / worker-transcript must
      // keep resolving AFTER `done` (the build snapshot reads the on-disk product once
      // the run finishes; the workspace persists). Retain the most recent terminal
      // tasks and prune the oldest to bound memory. Active tasks are never in this list.
      terminalOrder.push(handle.taskId);
      while (terminalOrder.length > RETAINED_TERMINAL_TASKS) {
        const evict = terminalOrder.shift();
        if (evict !== undefined && evict !== handle.taskId) tasks.delete(evict);
      }
    }
  })();

  log.info('corp task started', { taskId: handle.taskId });
  return { taskId: handle.taskId };
}

type CorpHandlers = {
  [K in keyof CorpInvokeMap]: (
    wc: WebContents,
    request: CorpInvokeMap[K]['request'],
  ) => CorpInvokeMap[K]['response'] | Promise<CorpInvokeMap[K]['response']>;
};

const handlers: CorpHandlers = {
  'corp:start': (wc, req) => handleStart(wc, req),
  // The steer/ask/abort/permission/peek/chart/transcript handlers act on a CorpEngine.
  // A mesh task has no engine (its live feed comes over corp:event), so these degrade
  // gracefully for it: fire-and-forget ops no-op, and read-backs return null (the folded
  // event stream already carries the chart + the feed).
  'corp:steer': (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task?.engine === undefined) return { ok: false };
    task.engine.steer(task.handle, req.text);
    return { ok: true };
  },
  'corp:ask': async (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task === undefined) {
      return {
        answer: "That production isn't loaded any more — start a new chat to begin a fresh one.",
      };
    }
    if (task.engine !== undefined)
      return { answer: await task.engine.ask(task.handle, req.question) };
    /*
     * A MESH RUN CAN BE TALKED TO. It could not before: this branch required
     * `task.engine`, a mesh run has none, and the mesh is the implementation —
     * so every follow-up question ever asked of a corporation, running or not,
     * got told to start a new chat. The user asked one mid-run and got exactly that.
     */
    const ask = (task.handle as { ask?: (q: string) => Promise<string> }).ask;
    if (typeof ask !== 'function') {
      return {
        answer: "That production isn't loaded any more — start a new chat to begin a fresh one.",
      };
    }
    return { answer: await ask(req.question) };
  },
  'corp:abort': (_wc, req) => ({ ok: abortCorpRun(req.taskId) }),
  'corp:respond-permission': (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task?.engine === undefined) return { ok: false };
    task.engine.respondToPermission(task.handle, req.requestId, req.granted);
    return { ok: true };
  },
  'corp:get-org-chart': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return { chart: task?.engine === undefined ? null : task.engine.getOrgChart(task.handle) };
  },
  'corp:worker-transcript': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return {
      transcript:
        task?.engine === undefined
          ? null
          : (task.engine.getWorkerTranscript(task.handle, req.nodeId) ?? null),
    };
  },
  'corp:peek': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return { peek: task?.engine === undefined ? null : (task.engine.peek(task.handle) ?? null) };
  },
};

/** Register the corp channels (sender-aware + trusted-sender gated). Always
 * registered; only reached when the experimental flag / env override is on. */
/**
 * Run a corporation TO COMPLETION for a blocked caller, and resolve with what it
 * delivered. This is the app half of `talk_to_manager`.
 *
 * The CEO calls the tool, the tool blocks on this, the team runs, and the tool's
 * result IS the finished product — "as far as the ceo knows they call manager
 * and receive the complete working product" (the user). Nothing here starts a second
 * CEO or re-reads the user's prompt: the `task` is the CEO's own brief to its
 * manager, passed through verbatim.
 *
 * The renderer is told the taskId so the situation room attaches to the run it is
 * already receiving events for — main starts it now, rather than the renderer
 * starting a parallel one off a status signal.
 */
export async function runCorpForBridge(
  wc: WebContents | null,
  task: string,
  /** Fires when the CEO stops waiting — its turn was stopped, or its chat deleted. */
  signal?: AbortSignal,
): Promise<{ ok: boolean; product: string; error?: string; workspace?: string }> {
  if (wc === null || wc.isDestroyed()) {
    return { ok: false, product: '', error: 'no window to run the production in' };
  }
  let started: { taskId: string };
  const workspace = currentWorkspaceDir();
  try {
    /*
     * THE CHAT'S WORKSPACE, not a fresh resolution.
     *
     * This path — the CEO's blocking `talk_to_manager` — is how a corporation
     * actually starts, and it passed no ctx at all. So handleStart fell back to
     * `'new chat'` and the team worked in ~/Bobble/new-chat while the chat had
     * already renamed itself from its first message. MEASURED twice: two folders
     * for one conversation, the work split. Fixing the renderer's startCorpTask
     * was not enough, because the renderer is not the caller here.
     */
    started = await handleStart(wc, {
      prompt: task,
      effort: 'max',
      ...(workspace !== null ? { ctx: { cwd: workspace } } : {}),
    });
  } catch (err) {
    return { ok: false, product: '', error: err instanceof Error ? err.message : String(err) };
  }
  const { taskId } = started;
  /*
   * THE CEO IS ALREADY GONE — its turn was stopped, or its chat deleted, while
   * the team was being put together. Nobody will receive this production, so it
   * is stopped, and not announced: announced now, the situation room would
   * bind it to whichever chat is on screen.
   */
  if (signal?.aborted === true) {
    abortCorpRun(taskId);
    return { ok: false, product: '', error: 'stopped — the CEO stopped waiting' };
  }
  // Let the situation room bind to this run (it did not start it).
  try {
    if (!wc.isDestroyed()) events.send(wc, 'corp:attached', { taskId });
  } catch {
    /* the run proceeds whether or not anyone is watching */
  }
  /* And the moment the CEO stops waiting, the team stops too — the composer's
     "halt all agents", reached whatever the store points at. */
  const onGone = (): void => void abortCorpRun(taskId);
  signal?.addEventListener('abort', onGone, { once: true });
  let result: TaskResult | null;
  try {
    result = await new Promise<TaskResult | null>((resolve) => {
      deliveries.set(taskId, resolve);
    });
  } finally {
    signal?.removeEventListener('abort', onGone);
  }
  /*
   * WHAT IS ON DISK, reported alongside the outcome.
   *
   * A failed hand-off is not an empty workspace, and the CEO was being told it
   * was: run 2's manager exhausted its step budget without replying and the tool
   * result said "Nothing was delivered" over a compiling 2,452-line codebase.
   * Only this side knows the cwd, so only this side can answer the question —
   * see CorpRunResult.workspace.
   *
   * IT HAPPENED AGAIN IN RUN 15, for a different reason, and that is the point:
   * this read `currentWorkspaceDir()` — module state set only once a workspace
   * has been RESOLVED — which was null, so `built` was '' and the CEO was told
   * "Nothing was delivered" over 53 files and 77 minutes of work by four
   * engineers. It then told the user the hand-off had failed and nothing was
   * produced. A false negative costs exactly what a false completion does.
   *
   * So the source of truth is now the directory THIS RUN recorded when it
   * started, not a guess made before it and re-read after. The old lookup stays
   * as a fallback for a task that somehow left no record.
   */
  const ranIn = tasks.get(taskId)?.cwd ?? workspace;
  /*
   * THE ABSOLUTE PATH LEADS THE TREE. `listProject` returns paths relative to
   * the workspace, and the CEO does not know what they are relative TO — run
   * 15's went looking in `~/Bobble/…` and `/Applications` and concluded nothing
   * had been built. A list of filenames is not an address.
   */
  const built = ranIn != null ? `${ranIn}\n${listProject(ranIn)}` : '';
  if (result === null) {
    return {
      ok: false,
      product: '',
      error: 'the production ended without delivering',
      ...(built !== '' ? { workspace: built } : {}),
    };
  }
  if (result.outcome !== 'completed') {
    return {
      ok: false,
      product: result.summary ?? '',
      error: result.error ?? `production ${result.outcome}`,
      ...(built !== '' ? { workspace: built } : {}),
    };
  }
  /*
   * The SUCCESS path carries the tree too. The CEO's next instruction is to open
   * the thing and use it as the user — which needs somewhere to open. Without
   * this it was told a product exists and left to guess where, and run 15 shows
   * exactly how that guessing goes: it searched `~/Bobble/…` and `/Applications`
   * and concluded nothing had been built, while the work sat in the chat's own
   * directory.
   */
  return { ok: true, product: result.summary ?? '', ...(built !== '' ? { workspace: built } : {}) };
}

export function registerCorpIpc(): void {
  for (const channel of CORP_INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, request: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel, wcId: event.sender.id });
        throw new Error(`[corp] rejected "${channel}": untrusted sender`);
      }
      const handler = handlers[channel] as (wc: WebContents, request: unknown) => unknown;
      return handler(event.sender, request);
    });
  }
}
