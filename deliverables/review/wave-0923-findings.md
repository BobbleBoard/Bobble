# Review of the 2026-09-23 wave (c9fe7098..6eb58aaf)

Run `wf_b2330c71-d84` (5 finders, 3 skeptics per finding). It stopped when the account hit its monthly spend limit (~19:35).
**Confirmed** = 3 of 3 independent skeptics agreed. **Unverified** = the finder reported it but its skeptics never ran (spend limit), so it is a candidate, NOT refuted. No fixes were applied.

## vision
### CONFIRMED [high] Calibration and clicked rapid-mlx rows are silently rewritten to the vision lane (spec none), so MTP and DFlash rows re-measure the same server
`packages/inference/src/vision-launch.ts:92`

**Scenario.** Setup: Apple Silicon with Vision on (the default). rapid-mlx and its vision runtime are installed; ensureDefaultEngines adds 'rapid-mlx-vision' while Vision is on. qwen3.5-4b-mtp has its MLX twin (297 vision_tower tensors), MTP sidecar and DFlash drafter on disk. The user presses Calibrate. The candidates rapid-mlx/none, rapid-mlx/mtp and rapid-mlx/dflash are each started with an explicit profile. planVisionEngine turns all three into {rapid-mlx, none} + --mllm. Candidates 2 and 3 pass startExternalEngine's reuse gate (same profile, fingerprint and command), so they return the already-running lane in about 0 ms and benchServer measures the same server again. The saved record then holds 'rapid-mlx/mtp' and 'rapid-mlx/dflash' rows carrying lane numbers and near-zero startup. chooseProfile can pick one of them, and that configuration was never measured. It is exactly what launches once Vision is switched off. The same rewrite hits a row the user clicks (applyProfile is explicit): clicking 'rapid-mlx · MTP' runs rapid-mlx without MTP. That contradicts the plan's own comment 'A clicked row is honoured as clicked'. Related: calibrate's final switch to the winner is also explicit, so a text-only winner (dflash-mlx, mlx-dspark) comes up blind with Vision on, while the next implicit start moves the same model to llama.cpp with vision.

**Evidence.** vision-launch.ts:92-95 (the lane rewrite to spec 'none') runs before the explicit check at :104. supervisor-entry.ts:2230-2233: calibrate calls startServer(model.id, file.quant, 'fast-text', 1, {engine, spec}), which sets explicit=true at :2515. :1690-1699: the external reuse gate compares only profile, fingerprint and launchCommand. :2422: applyProfile passes the clicked profile. calibrate.ts:202-208 plans none, mtp and dflash for rapid-mlx. I ran planVisionEngine directly: explicit rapid-mlx/mtp and rapid-mlx/dflash both return {profile:{engine:'rapid-mlx',spec:'none'},vision:'lane'}.

### CONFIRMED [medium] With Vision off, sending an image never starts or waits for the chat server
`apps/desktop/src/state/local-model.ts:341`

**Scenario.** Setup: Vision switched off, Auto selection (the default), and the chat server down: it crashed (phase 'error'), was stopped, or is otherwise not up. The composer only queues while the phase is 'starting'. The user sends a message with a picture. dispatchPrompt takes the image branch and calls ensureVisionMode(). resolveVisionTarget returns {action:'off'} before it looks at the model at all, so ensureVisionMode returns {ok:true}. ensureChatServerReady() is called only in the non-image else branch, so it is skipped, and pi:prompt goes to a dead endpoint. The user gets 'fetch failed' or a 503 in the thread. Before this change, the same send resolved a vision-capable tier pick and called activateLocalModel, which started the server. A text-only message in the same state still restarts the model.

**Evidence.** local-model.ts:341 `if (s.visionOff === true) return { action: 'off' };` comes before the model checks. :405-407 treat 'off' like 'already-on' and return {ok:true, changed:false}. pi-connect.ts:576-599: `if (messageNeedsVision(...)) { ... await ensureVisionMode() }` versus `else { await maybeRouteAuto(...); await ensureChatServerReady(); }`. ChatComposer only queues on modelLoading, and modelReadyStage (harness-status.ts:134-136) is true only for phase 'starting'.

### CONFIRMED [medium] Turning Vision off on a multimodal-launched server relaunches it multimodal, so it keeps reading images
`apps/desktop/electron/inference/supervisor-entry.ts:2348`

**Scenario.** Setup: the running server was launched with launchMode 'multimodal' by ensureVisionMode's relaunch. That happens, for example, when an image is attached while a text-only model (nanbeige4.2-3b, ling-3.0-tiny) is loaded and the app switches to a vision tier model, or when a blind engine is relaunched to see. The user then flips Vision off in the engine menu. VisionRow saves loadVision=false and calls relaunch(). The supervisor's relaunch() restarts with c.launchMode, which is still 'multimodal'. That makes visionWanted = launchMode==='multimodal' || loadVision = true, forces llama.cpp and re-attaches the projector. After a full reload the server has visionReady=true: the switch shows Off, the menu line says 'Reads images', and resolveVisionTarget returns 'already-on' (checked before visionOff). Pictures keep being sent and read.

**Evidence.** supervisor-entry.ts:2348 `startServer(c.model.id, c.file.quant, c.launchMode, 1, undefined, true)`. :2487-2495: multimodal forces wished to llamacpp. :2503 `const visionWanted = launchMode === 'multimodal' || loadVision;`. :2653: mmprojFile is resolved whenever visionWanted is true. EngineMenu.tsx:515-523: VisionRow calls relaunch(). local-model.ts:332: visionReady/multimodal returns 'already-on' before the off check at :341.

### CONFIRMED [low] A Vision switch flipped while the model is loading is never applied
`apps/desktop/src/chat/EngineMenu.tsx:518`

**Scenario.** Setup: a model is loading (phase 'starting'). The llama.cpp path disposes current before it spawns, so status.serverRunning is false. The user flips Vision off, and VisionRow only persists the setting because `if (status.serverRunning)` skips the relaunch. The in-flight start already captured visionWanted=true, so the server comes up with the projector and visionReady=true. The renderer then answers 'already-on' and pictures are sent and read with the switch Off, until some later unrelated relaunch. Flipping it on mid-load does the reverse: the server comes up with blindReason 'off', the model is told 'vision is switched off' while the switch shows On, and the menu line is wrong.

**Evidence.** EngineMenu.tsx:517-522: `await update({ loadVision: on }); if (status.serverRunning) { ... relaunch() }`. supervisor-entry.ts:514: serverRunning is `(current?.supervisor.running ?? false) || parked`, and current is null for the whole load. :2503 captures visionWanted once at start. local-model.ts:332 returns already-on whenever visionReady is true.

### CONFIRMED [low] The 'already resident' reuse never matches for a text-only model while Vision is off
`apps/desktop/electron/inference/supervisor-entry.ts:2608`

**Scenario.** Setup: Vision off, with a llama.cpp model that has no projector resident (for example nanbeige4.2-3b or ling-3.0-tiny, both on this Mac). Its launch stored blindReason 'model', not 'off'. The new gate `(current.blindReason === 'off') === !visionWanted` becomes `false === true`, so every start-server for that same model skips the ALREADY RESIDENT reuse. That includes Models → 'Use' on the loaded model and two serialized starts racing, which the comment relies on resolving to a no-op. Each one disposes and reloads the server: tens of seconds, a new port and a cold prefill. Before this wave the same call was a no-op.

**Evidence.** supervisor-entry.ts:2600-2611 (the reuse gate, with the new clause at :2608). :2984-2992: `blindReason: !visionWanted ? (model.mmproj !== undefined ? 'off' : 'model') : ...`, so a text-only model with vision off gets 'model'. ModelsView.tsx:1431 calls activateLocalModel for the chosen text model without a residency check.

### CONFIRMED [low] Images returned by tools still get the note with no reason
`packages/provider-llamacpp/src/stream.ts:383`

**Scenario.** Setup: Vision switched off, or the engine is blind. The model takes a browser_snapshot({visual:true}) or a mac snapshot --visual, the path this wave targets. The tool-result branch calls serverCanSeeImages(), which throws away the reason, and unviewableImageNote() with no argument. blindNote(undefined) then produces 'the model server cannot read images right now'. The model is never told that vision is switched off or where to turn it back on. That contradicts the settings contract ('an image a tool produces is described to the model as "vision is switched off"') and vision-want.ts. Only images the user attaches, which go through contentToOAI, get the reason.

**Evidence.** stream.ts:383-390: `if (images.length > 0 && !serverCanSeeImages()) { ... content: `[image returned by ${msg.toolName}] ${unviewableImageNote()}` }`, whereas contentToOAI at :264-268 uses visionState() and passes vision.reason. settings-contract.ts loadVision doc comment.

### unverified [low] The vision fallback to llama.cpp is not checked first: a sharded GGUF refuses to start and nothing falls back to the chosen engine
`packages/inference/src/vision-launch.ts:108`

**Scenario.** Setup: qwen3.5-122b-a10b-mtp (sharded: true, with an mmproj and an mlxRepo) on a 96 GB+ Mac. The MLX twin and the first GGUF shard are on disk, and the model is calibrated to dflash-mlx, mlx-dspark or omlx (or rapid-mlx without its vision runtime). With Vision on, planVisionEngine hands the launch to llama.cpp: ggufOnDisk is true because shard 1 exists, and modelHasProjector is true. startServerExclusive's sharded guard then returns 'published in multiple shards…' and the model does not start. There is no path back to the calibrated MLX engine, which ran it fine before this wave. A related case: offline with the projector not yet on disk, the plan still leaves rapid-mlx+MTP for llama.cpp, the projector fetch fails, and the model comes up blind anyway on the slower engine.

**Evidence.** vision-launch.ts:108-114 decides the fallback only on `input.ggufOnDisk && input.modelHasProjector` (catalog presence). supervisor-entry.ts:2517 `ggufOnDisk: existsSync(modelPathFor(model, file))`. :2557-2565: the sharded refusal runs after the plan chose llama.cpp. catalog.ts:907-957 (QWEN35_122B_A10B_MTP: sharded, mmproj, mlxRepo). The external-failure fallback at :2544-2551 only goes external→llama.cpp, never back.

### unverified [low] mlxTwinHasVision reads the entire model.safetensors to get its header
`apps/desktop/electron/inference/supervisor-entry.ts:1520`

**Scenario.** Setup: an MLX twin that ships a single model.safetensors without model.safetensors.index.json. If the file is over 2 GiB, readFileSync throws ERR_FS_FILE_TOO_LARGE (I confirmed this on Node 26 with a 2.2 GB file). The error is swallowed and the function returns false, so rapid-mlx never gets its vision lane: the launch falls back to llama.cpp or runs blind, and 'Fetch missing' never offers the runtime. If the file is under 2 GiB, the whole file (up to 2 GiB) is read synchronously on the inference supervisor's event loop on every start and every time the engine menu opens (companionsOf). That stalls status and IPC replies and spikes memory, although only the first 8+n bytes are needed.

**Evidence.** supervisor-entry.ts:1517-1526: `const buf = readFileSync(single); const n = Number(buf.readBigUInt64LE(0)); JSON.parse(buf.subarray(8, 8 + n)...)` sits inside a catch that returns false. It is called from companionsOf (:1436) and startServerExclusive (:2518).

### unverified [low] 'Fetch missing' keeps counting the vision runtime after it installs, and pressing it again reinstalls
`apps/desktop/src/chat/EngineMenu.tsx:356`

**Scenario.** Setup: the engine menu shows 'Fetch missing · 1 (install rapid-mlx's vision runtime)' and the user presses it. The install succeeds, but 'rapid-mlx-vision' is not in KNOWN_ENGINE_IDS, so the engines store never shows it as busy or installed. anyInstalling never changes and the companions effect does not re-run. The button keeps saying 'Fetch missing · 1' until the menu is reopened. Pressing it again reinstalls, and the reinstall first deletes the ready marker, so a launch during it falls back off the lane. Nothing relaunches after the install either, so VisionRow keeps saying 'on llama.cpp, because … not installed'.

**Evidence.** EngineMenu.tsx:342-356: the effect deps are [open, modelId, quant, fetching, anyInstalling], and anyInstalling is derived from the engines store. :378-386: run() installs the runtime without refreshing `missing`. llm-main.ts:780-792: KNOWN_ENGINE_IDS lacks 'rapid-mlx-vision', so engines:list never reports it. engines-main.ts:572: install begins with rmSync(rapidVisionMarker()).

## delete
### unverified [high] Deleting a chat that is waiting on ask_user or a permission prompt blocks all later messages: pi:abort never returns
`apps/desktop/src/state/pi-connect.ts:446`

**Scenario.** Chat A is on screen and its turn has called ask_user (an inline question card that does not block the sidebar). Or A is running in the background with the orange needs-input dot and a pending ask_user or permission request. The user deletes A. abandonChats drops A's uiRequests without answering pi, then awaits pi:abort (line 446 when A is on screen, line 449 when it is in the background). pi only acknowledges abort once the agent is idle. The agent can never go idle: the tool is stuck in ctx.ui.input with no signal and no timeout, and that question can no longer be answered. abandonChats never reaches its retry loop, the 'let go' branch or ensurePiOnViewedSession. bgRun stays {A, streaming:true}, pendingNewSession stays true and pi stays on the deleted file. Every later message in the new chat or any other chat is queued and never drained. Stop sends pi:abort again, which also hangs, and clears the queue. Only a pi respawn (model switch or app restart) recovers. The same thing happens if the dying turn raises a dialog after the delete has started. That late request also re-adds unread['needs-input'] for the deleted chat (sink uiRequest). The result is a dock badge and a 'needs you' notification that can never be cleared.

**Evidence.** pi-connect.ts:436 filters the deleted chat's uiRequests and never calls pi:respond-ui {cancelled:true}. pi-connect.ts:446, :449 and :476 do `await invoke('pi:abort')` with no timeout. harness tools/ask-user.ts:148 calls `ctx.ui.input(spec.question, …)` without a signal; permissions/modes.ts:185 does the same. pi-agent-core agent-loop executePreparedToolCall awaits tool.execute and does not race the abort signal. pi rpc-mode `case "abort": await session.abort()`, and AgentSession.abort awaits agent.waitForIdle(). packages/engine/src/main/pi-bridge.ts:503: abort() calls send() with no timeoutMs. pi-sessions.ts:344 returns ack(bridge.abort()). sendPrompt (pi-connect.ts:510-518) enqueues while bgRun.streaming is true. canDrainQueue (pi-slice.ts:492) needs bgRun.streaming !== true.

### unverified [high] Corp team is not aborted unless the store still points at it, so the CEO's blocked talk_to_manager stalls abandonChats for the whole production; the wrong chat's team can also be aborted
`apps/desktop/src/state/chat-delete.ts:43`

**Scenario.** (a) Chat A's CEO calls talk_to_manager and the production starts. The user switches to chat B; A keeps running in the background, and setMessagesExternal → setTask(null) clears taskId/corpRunning. The user then deletes A. team is null, so corp:abort is never sent. abandonChats aborts A's pi turn, but talk_to_manager ignores the abort signal and the corp bridge client has no abort path. So `await pi:abort` (pi-connect.ts:449) waits until the whole team delivers, which is tens of minutes to hours. For that whole time bgRun stays streaming for a deleted chat, every message in every chat is queued, and the manager and engineers keep using the model and writing into A's workspace. The same happens with A on screen if the user ever switched away and came back (Case B also nulls the task). (b) Reverse case: A's CEO starts the production while B is on screen. corp:attached binds A's task in the store. Deleting B then sends corp:abort for A's production and disposes the corp children that were mirrored under B.

**Evidence.** chat-delete.ts:41-43 `team = onScreen && corp.corpRunning ? corp.taskId : null`. pi-slice.ts:326 calls setTask(null) in setMessagesExternal, which runs on every switch case and on New chat. ChatApp.tsx:564-566 binds corp:attached whichever chat is viewed. ChatApp.tsx:498 sets parentId to the viewed session. harness corp/promote-tool.ts:301 has execute(_toolCallId, params, _signal…) and ignores the signal. corp/bridge-client.ts:74-84 says 'Abort travels the other way'. corp-main.ts:595-597: runCorpForBridge waits on deliveries, which only corp:abort ends early.

### unverified [medium] Generations waiting at the module/weights/consent gate cannot be cancelled and run later for the deleted chat; the gen tools also ignore abort, which stalls the pipeline up to 15 min
`apps/desktop/electron/gen/gen-manager.ts:810`

**Scenario.** A chat asks for an image, video or audio from a model whose runtime or weights are missing. The user clicks Download, starting a multi-GB install, and the job waits in ensureModule/ensureWeights (or in ensureAsset for GPL consent). The user deletes the chat. cancelJobsOf forgets the id and sends gen:cancel. cancelJob → jobQueue.cancel(id) returns false because the job is not queued yet, and nothing records the cancel. When the install finishes, the job is queued and runs to the end, holding the GPU for a chat that no longer exists. Meanwhile the dying turn sits inside the gen tool's bridge.request, which ignores the abort signal. pi:abort, and therefore abandonChats, is blocked until the job finishes or the 15-minute client timeout fires (4 min if Download was never pressed). During that time bgRun stays streaming and every message is queued.

**Evidence.** gen-manager.ts:644 announces the job, then :810-818 await ensureModule/ensureWeights/ensureAsset/freshReading before jobQueue.enqueue at :819. Same pattern at video :857/:933-942, audio :1022/:1109-1118 and run3d :1515-1518. gen-manager.ts:608-614: cancelJob → jobQueue.cancel; job-queue.ts cancel() returns false when the entry is unknown. chat-jobs.ts:86 calls forgetJob before the invoke. gen-modules.ts:363-373: ensure() awaits an in-flight install. packages/gen-tools/src/tools.ts:210/330/484/686 `execute(_id, params)` takes no signal. gen-bridge-client.ts DEFAULT_REQUEST_TIMEOUT is 15 min.

### unverified [medium] Jobs announced after the delete's cancel pass are never cancelled (gen3d announces only after admission and sidecar boot)
`apps/desktop/src/state/chat-jobs.ts:59`

**Scenario.** Chat A calls generate_image (mageflow through the gen3d sidecar) or generate_3d while the sidecar is cold, or while admitSidecarJob is waiting up to 20 s for memory. The job has no id yet, so cancelJobsOf finds nothing; it takes its list of owned jobs once, synchronously, at delete time. The harness tool returns 'cancelled' on abort, but main carries on: the sidecar accepts the job and noteAgentJob broadcasts gen3d:agent-job. The renderer records it against whatever chat is current, either the deleted chat still parked in bgRun or the fresh chat. Nothing cancels it, so a 15 GB image model or a 5–40 min mesh runs for a deleted chat. noteAgentJob never checks isChatDeleted(owner). A subagent's job announced after removeChild gets owner null, which has the same effect.

**Evidence.** gen3d-main.ts:552-569 (runImageJob) and :616-645/:671 (run3dJob/runStage3dJob) call noteAgentJob only after sidecarPost/admitSidecarJob (:852-871, ADMISSION_WAIT_MS 20 s, ensureSidecar cold start). chat-jobs.ts:50-59 records the owner with no deleted check. chat-jobs.ts:82-83 takes jobsOwnedBy once. image-bridge-client.ts:95-96 resolves 'cancelled' on abort while the main-side handler keeps running.

### unverified [medium] ComfyUI 3D jobs (c3d_ ids) cannot be cancelled: gen3d:cancel posts to the sidecar, and the real queue job has a different id
`apps/desktop/electron/gen3d/gen3d-main.ts:942`

**Scenario.** On a Mac without the Bobble 3D engine core (sidecarCoreInstalled() false, ComfyUI 3D ready), the chat's generate_3d from a picture goes run3dJob → handlers['gen3d:generate'] → runComfy3d. That returns jobId 'c3d_…', and noteAgentJob announces this id. Deleting the chat invokes gen3d:cancel {jobId:'c3d_…'}, which only runs sidecarPost('/cancel'). The sidecar has no such job, and if the sidecar is not running, ensureSidecar() may boot it (even bootstrap uv) just to deliver a no-op. The actual work runs in gen-manager's JobQueue under a new id 'gen3d_…' that nothing maps back. So TRELLIS.2/Pixal3D keeps the GPU for its full 5–25 minutes after the chat is gone.

**Evidence.** gen3d-main.ts:942 creates `c3d_${…}` and :993 calls runner(…); main.ts:943 wires setComfy3dRunner(genQueue.run3d). gen-manager.ts:1491 creates `gen3d_${…}`, enqueued at :1518. gen3d-main.ts:1228-1231: 'gen3d:cancel' only runs sidecarPost('/cancel'). sidecarPost → ensureSidecar → startSidecar (uv bootstrap, server spawn).

### unverified [medium] Subagent ownership follows the viewed chat, so deleting the viewed chat kills a background chat's subagent and its generations, and deleting the background chat leaves its subagent running
`apps/desktop/src/state/chat-delete.ts:45`

**Scenario.** Chat A runs in the background while the user views B, and A's turn calls spawn_subagent. Main parents the child to activeSession, which is B, the chat the renderer last reported as viewed. Deleting B makes deleteChatNow dispose that child. A's blocked spawn_subagent then gets a failure mid-task, and the child's image, SVG or 3D jobs are cancelled because owner = childParent = B. Deleting A instead leaves its subagent and the subagent's generations running, because their parentId is not in A's files.

**Evidence.** subagent-bridge.ts:83 `parentId: activeSession`; activeSession is set from pi:report-active-session, which is the viewed session (pi-connect.ts:151-157). chat-delete.ts:45 filters children by c.parentId. chat-jobs.ts:44/55 derive the owner from children[agent].parentId.

### unverified [medium] A stale notification click reopens a deleted chat, and anything written there is silently swept by tombstones
`apps/desktop/src/chat/SessionSidebar.tsx:768`

**Scenario.** Background chat A asks a question and the OS shows 'A background chat needs you' with sessionFile A. The user deletes A from the sidebar and later clicks that notification in Notification Center. onOpen(A) → switchSession(A) runs with no deleted check. In Case D, pi:switch-session A goes to pi's SessionManager.open, which creates a fresh session at that exact missing path. The user chats, and pi writes A's file again. For 7 days, each listing's tombstones.sweep() and the 2 s/10 s timers delete it, and the row never appears because of deletedFiles and the tombstone filter. The new conversation is silently lost. If A is still the parked bgRun, Case B instead puts the deleted thread back on screen and clears bgRun.

**Evidence.** SessionSidebar.tsx:768-771 calls onOpen(sessionFile) and :752-757 calls switchSession, with no isChatDeleted guard; pi-connect switchSession has none either. pi SessionManager.setSessionFile creates a new session at the explicit path when the file is missing. fs-handlers.ts:295 sweeps and :301 skips tombstoned files on every listing. session-tombstones.ts sweep() calls rmSync on any existing tombstoned path.

### unverified [low] The tombstone is written before the rm, so a failed delete can never bring the row back as documented
`apps/desktop/electron/fs-handlers.ts:512`

**Scenario.** rmSync fails for one file in the chain (EACCES/EPERM, e.g. a session file owned by root). deleteSession returns {ok:false}. deleteChatNow restores the row, but by then the turn, subagents, jobs and team have already been stopped and the snapshot deleted. The tombstone written first makes listAllSessions skip the file, so the row stays hidden anyway, and the sidebar ignores the error (`void deleteChatNow(s).then(refresh)`). Each listing retries the rm silently. When the 7-day TTL expires, the undeletable chat reappears in the sidebar.

**Evidence.** fs-handlers.ts:512 calls tombstones.add(targets) before the rm loop, and nothing removes the tombstone on failure. fs-handlers.ts:301 `if (tombstones.has(...)) continue`. chat-delete.ts:66-68 restores only the renderer-side hidden set. SessionSidebar.tsx:908/919 drop the result.

### unverified [low] When any drawing ends, every svg- id is forgotten, so a concurrent drawing can no longer be cancelled
`apps/desktop/src/state/chat-jobs.ts:108`

**Scenario.** Two OmniSVG drawings run at the same time, for example the main pi and a subagent, or two subagents; nothing serializes generateSvg, and each call starts its own llama-server. The first finishes and gen:svg-live 'done' arrives, which forgets every 'svg-' id, including the one still running. Deleting the chat that owns the second drawing then sends no cancel, and it runs to completion.

**Evidence.** chat-jobs.ts:105-109 ('One drawing at a time' is assumed but not enforced). gen-manager.ts:1183-1203 has no lock around generateSvg and registers each run in svgRuns under its own id.

### unverified [low] Deleting a streaming chat leaks bgStartedAt, so the next background run's 'finished' notification ignores the duration floor
`apps/desktop/src/chat/SessionSidebar.tsx:585`

**Scenario.** The user deletes a streaming chat, either on screen (newSession parks it in bgRun as streaming) or in the background. Its bgRun goes streaming true→false, but the new isChatDeleted guard skips the whole block, including `bgStartedAt.current = null`. The next background run keeps the stale start time, because line 580 only sets it when null. When that run finishes after a few seconds, ranFor is minutes, and the 'It finished while you were away' OS notification fires despite NOTIFY_MIN_RUN_MS.

**Evidence.** SessionSidebar.tsx:580 sets the start only when null; :585 has the isChatDeleted guard; :611 resets it only inside the guarded block.

## computer-use
### unverified [high] Any chrome_* command silently moves control of every later mac_* act to Chrome: keys, menus, typing and index or coordinate clicks go to the wrong app, and Chrome is never asked about
`packages/mac-computer-use/src/tools.ts:1707`

**Scenario.** 1. `mac launch TextEdit` (or `mac snapshot "TextEdit"`). The launch result tells the model "mac_snapshot, mac_click, mac_type and mac_key all target it now" (tools.ts:1634-1636).
2. Any chrome_* call that reaches noteChrome:
   - `chrome snapshot --visual`, always.
   - Every chrome_snapshot, chrome_click, chrome_type and chrome_go on a Mac where AllowJavaScriptAppleEvents=1. On the user's machine `defaults read com.google.Chrome AllowJavaScriptAppleEvents` returns 1.
3. The model goes back to TextEdit and runs `mac key cmd+s`, `mac click menu:"File > Save"`, `mac type [3] "..."`, `mac scroll` or a bare `mac snapshot`. Every one is stamped with Chrome's pid:
   - cmd+s opens Chrome's Save Page dialog.
   - The typed text goes into Chrome's element [3] (a web form field) whenever the shared, long-lived helper has an index map for Chrome. The visual look builds that map itself.
   - A `mac click x,y` read off an earlier `--visual` picture of another app is translated with that app's frame and posted to Chrome.
4. The results give no hint: "Pressed cmd+s. (delivered to the controlled app...)" and "Set text into [3]." The overlay and the monitor still show TextEdit.
5. The consent gate is bypassed. An act that names no app passes when any app was granted (permissions.ts:210), so Chrome is driven with no question even under a policy that lists only TextEdit.

**Evidence.** - tools.ts:1707-1712: `noteChrome` calls `session.restore({ app: CHROME_APP, pid })` (restore also drops elements, dialogKey and lastAct). It is called at 1798 (evalInChrome) and 1838 (the visual path).
- tools.ts:626-628: `withTarget` stamps `session.targetParams()` onto every act.
- tools.ts:462, 471, 479: `blocked`, `names` and `visualFrame` still describe the previous app.
- Serve.swift resolveElement uses `params.pid` first; actTargetPid delivers keys to that pid.
- Scratch probes with a shared session (policy allowing only TextEdit, hasUI:false):
   - After `chrome_snapshot {visual:true}`, `mac_type {index:3,text:'secret note'}` went out as `{index:3,...,pid:4321,app:"Google Chrome"}`.
   - `mac_key cmd+s` went out as `{combo:"cmd+s",pid:4321,app:"Google Chrome"}`.
   - `mac_click menu:"File > Save"` went out as `{path:"File > Save",pid:4321,app:"Google Chrome"}`.
   - After a Preview visual look (rect 500,300), `mac_click {x:100,y:100}` went out as `{x:600,y:400,pid:4321}`.

### unverified [high] Carried-over control makes every session send the global setDriving:false when its turn ends: another chat's overlay and live monitor are torn down and the user's Stop/take-over brake is released
`packages/mac-computer-use/src/tools.ts:448`

**Scenario.** 1. Chat A is driving Chrome, so the last-control file names Chrome.
2. Another session starts while Chrome runs: a subagent A spawned, a background or new chat, a corp role agent, or a scheduled-task run. All of them load this extension (extension-dirs.ts:62, "a SUBAGENT gets the same tools as the chat").
3. At session_start each one restores Chrome from the file, so `session.controlled()` is no longer null.
4. When that session's turn ends, its agent_end handler sends `setDriving {driving:false}`.
5. mac-agent handles that globally: `macOverlay.hide(); macMonitor.clearSession()`, and clearSession sets `#control = 'agent'`.
6. While chat A is still mid-run:
   - the phantom cursor disappears and the Activity stream stops;
   - if the user had pressed Stop or Take over (for example to type a password), the brake is lifted, so chat A's next act or screen-capturing look is allowed.
Before this wave, a session that never drove anything had controlled()===null and never sent this.

**Evidence.** - tools.ts:429-436: the carried-over restore at session_start.
- tools.ts:448-453: `if (bridge === null || session.controlled() === null) return; void bridge.request('setDriving', { driving: false })`.
- apps/desktop/electron/mac/mac-agent.ts:666-671: the setDriving handler has no per-session keying, and controlRefusal exempts setDriving (line 575).
- apps/desktop/electron/mac/monitor-core.ts:375-399: clearSession resets `this.#control = 'agent'` (line 396).
- Scratch probe: a session that only ran session_start (with the file present) and then agent_end emitted `[{"method":"setDriving","params":{"driving":false}}]`.

### unverified [medium] Carried-over control is never recorded as the chat's own, and the file's timestamp never refreshes, so a restarted or reopened chat takes whatever app another chat last wrote
`packages/mac-computer-use/src/tools.ts:433`

**Scenario.** 1. Chat B starts and carries Chrome from the file. `recordedPid` is set to Chrome's pid.
2. The model works only in Chrome. Every look hits the `c.pid === recordedPid` early return, so no `mac-control` entry is ever appended to chat B and the file is never rewritten.
3. Chat A switches to Blender, so the file now says Blender.
4. Chat B's pi child restarts (a vision relaunch, or the user switches back to the chat). session_start finds no entries of its own, reads the file, and chat B now controls Blender. Its next bare look, key or index click goes to Blender.
5. The same early return means `at` records when control of that pid was first taken, not when it was last used:
   - A chat working in one app all day stops being carried 12 h after it first took control, even if it was used a minute ago.
   - A chat that returns to its own app never becomes the "last" app again.

**Evidence.** - tools.ts:395: `if (c === null || c.pid === recordedPid) return;` skips both writeLastControl and appendEntry.
- tools.ts:433: `recordedPid = carried.pid`.
- Scratch probe: chat B appended 0 entries after two looks and a click. Reopened with its own (empty) entries after the file changed to Blender, its first look went out as `{"pid":1472,"app":"Blender","cap":60}`.

### unverified [medium] "Carried over from an earlier chat" is printed on the first text look, whatever app that look was of
`packages/mac-computer-use/src/tools.ts:492`

**Scenario.** 1. A new chat carries an app.
2. The model follows the tool's own advice ("If the user named an app, name it here too") and runs `mac snapshot "Safari"`.
3. The header reads `App: "Safari"` followed by "(Carried over from an earlier chat: the last app computer use worked in...)". This is false, and it is the same kind of misreport this wave set out to fix.
4. Other cases:
   - After `mac launch Notes`, the next bare look announces Notes as carried over.
   - A `--visual` first look never calls view(), so the flag stays set and fires on a later look at some other app.
   - A later bare look that really does use the carried app gets no banner.

**Evidence.** - tools.ts:434 sets `carriedOver = true`.
- tools.ts:492-499: view() emits and clears the flag on whichever text snapshot formats first. It is only called at 961 and ignores whether the look used the carried target (params.app, a launch).
- Scratch probe: first look `mac_snapshot {app:'Safari'}` printed `App: "Safari" ... | (Carried over from an earlier chat: ...)`.

### unverified [medium] The "this is the app the USER has in front" notice is lost for apps with no Accessibility tree, and never given on --visual looks
`packages/mac-computer-use/src/tools.ts:534`

**Scenario.** Case 1, the frontmost app exposes nothing to Accessibility (Blender, a game):
1. Nothing is controlled and the model runs a bare `mac snapshot`.
2. The first snapshot() sets lastLookFrontmost=true, and noteSnapshot takes control of the frontmost app.
3. The automatic retake (line 879) calls snapshot() again, now targeting the controlled pid, which sets lastLookFrontmost=false.
4. The header omits the notice, so the model again reports the user's app as where the user is.

Case 2, `mac snapshot --visual` with no app and nothing controlled:
1. The tool returns only an image of whatever is frontmost. There is no self-exclusion, so this can be Bobble's own window.
2. It silently takes control of that app, and nothing tells the model which app it is.

**Evidence.** - tools.ts:534: `lastLookFrontmost = params.app === undefined && params.pid === undefined;` is recomputed on every snapshot().
- tools.ts:877-880: the retake.
- tools.ts:829-874: the visual path never calls view().
- Scratch probe: the calls were `{cap:60}` then `{pid:555,app:"Blender",screenshot:true,cap:60}`, and the text had no "USER has" line.

### unverified [medium] chrome_snapshot --visual swallows the Stop/take-over refusal and tells the model to retry through the Apple-Events path, which ignores the brake; it also skips the consent and policy gate
`packages/mac-computer-use/src/tools.ts:1839`

**Scenario.** 1. The user presses Stop (or Take over) on the computer-use monitor.
2. The model calls `chrome snapshot --visual`.
3. mac-agent's controlRefusal throws "The user pressed Stop, so Mac control is off. Do not retry...".
4. ax() catches every error and returns null, so the tool answers "No picture could be taken of Chrome right now. Take a plain chrome snapshot instead."
5. With Apple-Events JS on (the user's machine), that plain snapshot runs chromeEval through osascript and never touches the bridge, so the page is read and driven while the brake is on. The model never learns the user stopped it.
6. Separately, mac_snapshot --visual goes through gate(): consent plus the policy, including "Computer use is switched off". This path has no gate at all, so it screenshots the user's logged-in Chrome window even when computer use is off in Settings or Chrome is not an allowed app.

**Evidence.** - tools.ts:1728-1735: `ax()` wraps bridge.request in `try { ... } catch { return null; }`.
- tools.ts:1839-1856: the generic retry advice.
- tools.ts:1790-1801: evalInChrome uses chromeEval (osascript) with no bridge call.
- apps/desktop/electron/mac/mac-agent.ts:571-587: the brake lives only in the bridge dispatch.
- tools.ts:806-807: mac_snapshot gates; tools.ts:1835-1861: the chrome visual path does not.

### unverified [low] With a default Chrome (Apple-Events JavaScript off), chrome_* never mark Chrome as controlled, so the "Chrome work leaves Chrome under control" fix does nothing; even when it runs, it is never persisted
`packages/mac-computer-use/src/tools.ts:1794`

**Scenario.** 1. On a default install, ensureChromeJs returns a message (setting off, declined, or no UI).
2. evalInChrome returns before `await noteChrome()`.
3. chrome_snapshot, chrome_click and chrome_type fall back to ax(), and none of them calls noteChrome.
4. After a run of chrome commands, a bare `mac snapshot` still falls back to the frontmost app. That is the "user is on Activity Monitor" symptom this change targeted.
5. Only the --visual path notes Chrome, and the new test covers only that path.
6. When noteChrome does run, restore() is not followed by recordControl(), so neither the mac-control entry nor the file learns Chrome. A pi restart restores the app that was controlled before Chrome.

**Evidence.** - tools.ts:1794-1798: `const blocked = await ensureChromeJs(ctx); if (blocked !== null) return {...}` comes before `await noteChrome()`.
- tools.ts:1863-1874 (snapshot), 1889-1891 (click) and 1923-1929 (type): the AX fallbacks with no noteChrome.
- tools.ts:1711: `session.restore(...)` only, with no persistence.
- tools.test.ts: the only noteChrome test uses `chrome_snapshot {visual:true}`.

### unverified [low] --visual click translation is wrong whenever the helper falls back from the ScreenCaptureKit composite
`packages/pi-mac/swift/Sources/pi-mac/Capture.swift:229`

**Scenario.** 1. captureComposite returns nil: an SCK error, the 8 s runBlocking timeout, or no shareable windows.
2. captureAppSurfaces then captures only `ids.first`, the frontmost surface (for example a save sheet), with `screencapture -l`. It still sets `rect` to the union of all the app's windows.
3. The image size comes back as `width`/`height` (downscaled at the main display's scale), not `inlineWidth`.
4. tools.ts maps picture pixels across the union rect using iw=rect.w. Example: union at (100,100), 1000×800; sheet 400×200 at (400,100). "Save" at (350,180) on the picture is clicked at (450,280) instead of (750,280), behind the sheet.
5. The same 2× error occurs when inlineImage fails and the full-resolution PNG is sent without inlineWidth.

**Evidence.** - Capture.swift:228-233: `if let first = ids.first, var shot = captureWindow(...) { shot["rect"] = rectDict(rect) ... }`, where rect is the union from unionFrame(windows).
- Screenshot.swift downscaledJPEG returns `width`/`height`.
- tools.ts:845-859 falls back to rect.w/rect.h when inlineWidth is absent.
- tools.ts:1062-1064 applies the scale.

### unverified [low] The scroll row reads "down NaN px" when --amount has no value attached
`apps/desktop/src/chat/cli-command-label.ts:215`

**Scenario.** `browser scroll --direction down --amount -300`:
1. cliFlags only takes the next word as a flag's value when it does not start with '-'.
2. So flags.amount becomes 'true'.
3. `Number('true')` is NaN, and the row shows target/detail "down NaN px".

`browser scroll down --amount` (no value) shows the same.

**Evidence.** - cli-command-label.ts:104: `pendingKey !== null && !word.startsWith('-')`.
- cli-command-label.ts:93: a flag with no value is set to `'true'`.
- cli-command-label.ts:215-218: `amount = flags.amount ?? ...; distance = `${Number(amount).toLocaleString('en-US')} px``.
- Ran the parser: `browser scroll --direction down --amount -300` produced `"target":"down NaN px"`, and `browser scroll down --amount` produced `"down NaN px"`.

## renderer-ui
### unverified [medium] Live preview takes frames from any job running at the same time: video cards now show other jobs' frames, and HyperFrames frames block an image card's own steps
`apps/desktop/src/media/PendingMediaCard.tsx:252`

**Scenario.** Chat A runs generate_image (gen3d sidecar). Meanwhile a HyperFrames clip renders somewhere else: the Video studio, a subagent or corp specialist, or a background chat. HyperFrames is light, so the JobQueue runs it alongside other light jobs, and gen3d is a separate engine anyway. Each rendered frame now arrives on gen:update with a previewSrc and step = frame index (1..~121). The image card's onFrame takes the first one, so `revealing` flips and the loader sweeps away onto a motion-graphics frame. From then on `latest` is ~100+, so the image's own denoise frames (step <= its step count) are dropped. The reverse also happens: a chat generate_video card (now live) shows another chat's or a studio's image denoise steps as if they were the clip's frames. Corp mesh agents run in parallel, which makes this overlap routine in team runs.

**Evidence.** PendingMediaCard.tsx:248-260 subscribes with `onFrame: (_jobId, frame) => { if (frame.step <= latest) return; latest = frame.step; setPreview(frame.dataUri); }`. The job id is ignored and one high-water mark is shared across every stream. This wave turned it on for video (AssistantGroup.tsx:375 and :411 `live={... || kind === 'video'}`) and made video progress events carry the frame (gen-manager.ts:913-921 `previewSrc: toSrc(event.previewPath)`, with hyperframes-still.ts:287-294 emitting `step: i + 1`). useDenoisePreview.ts genFrameFrom filters only audio, and subscribeToDenoise forwards every tabId/jobId (lines 88-110). The module's premise that only one job ever runs no longer holds: gen-manager.ts:429 `maxConcurrent: opts.maxConcurrent ?? 2`, catalog.ts:821 hyperframes `heavy: false`, and job-queue.ts:293-307 let light jobs run concurrently. gen3d image jobs are not in that queue at all.

### unverified [medium] (pre-existing) With Reduce Motion on, the exit sweep never starts on an already-mounted card, so studio runs never finish revealing and get dropped from the history
`apps/desktop/src/chat/BobbleLoader.tsx:315`

**Scenario.** macOS Reduce Motion is on and the user generates in the Image or Video studio. The PendingMediaCard mounts with no item. draw() runs once and does not reschedule. When the result arrives, `exit` flips to true, but it is only read inside draw(), the effect deps are [size, variant, fill], and the IntersectionObserver never restarts the loop because `running` is still true. So onExitDone, swept, onRevealed and finishReveal never fire. The run is never filed into the room's runs list and the card stays aria-busy. When the next generation completes, `pendingRun.current` is overwritten, so the earlier run disappears from the studio history for good (the file stays on disk). This wave also sends every live chat card (image and now video) through this exit path.

**Evidence.** BobbleLoader.tsx:315 `if (running && (!reduced || exitStarted !== undefined)) raf = requestAnimationFrame(draw);`. Line 234 notices the exit only inside draw. Line 340 deps `[size, variant, fill]` do not include exit. Lines 322-331: IO restarts only when `!running`. PendingMediaCard.tsx:270-274 and :361 make onRevealed depend on onExitDone. use-studio.ts:158-161 `finishReveal` is the only thing that calls file() during the session, and :231 reassigns `pendingRun.current` on the next run. The code comment at BobbleLoader.tsx:313-314 says the sweep is meant to run under reduced motion.

### unverified [low] Theme flip mid-generation makes the loader invisible: ink is read once, and the pending card no longer has a scrim
`apps/desktop/src/chat/BobbleLoader.tsx:222`

**Scenario.** Theme mode is 'system' (the default) and macOS Auto appearance flips at sunset, or the user presses the sidebar sun/moon toggle, while a chat or studio card is generating (minutes). The canvas keeps the ink it read at mount. The pending card's scrim is now transparent in both themes, and light mode swaps the ink to 82% text colour. Dark to light leaves white blocks on the light chat; light to dark leaves near-black blocks on the dark chat. The mark disappears for the rest of that generation. The same happens to a card mounted before the persisted light theme is applied over the index.html dark default. Before this wave the ink was always white and light mode added a live CSS scrim (rgb(22 22 26 / 72%)), so a flip stayed visible.

**Evidence.** BobbleLoader.tsx:222 `const ink = getComputedStyle(host).getPropertyValue('--pd-bobble-ink').trim() || '#ffffff';` runs once per effect, and the deps at :340 carry no theme. The new rule at global.css:6833-6836 sets `--pd-bobble-ink: color-mix(in srgb, var(--pd-text-primary) 82%, transparent); --pd-bobble-scrim: transparent;` for light only. The frame is also transparent while waiting (global.css:6806-6808). settings-store.ts:547-552 re-applies the theme live on `prefers-color-scheme` change.

### unverified [low] Thinking-timer ids still collide for corp-role chats across runs ('Thinking for 30m' on a fresh thought)
`apps/desktop/src/chat/AssistantGroup.tsx:331`

**Scenario.** The user runs a corp task and opens the Manager's (or Engineer 1's) child chat while its first thought is running. That records STEP_FIRST_SEEN['corp:manager:turn-a0:thinking:0'] = T0. Thirty minutes later a second corp task runs, and opening the Manager's chat during its first thought shows 'Thinking for 30m'. This is the symptom the wave set out to fix. The chainKey is built from group[0].id. Corp role chats get ids `${corpChildId(node.id)}:turn`, and node ids are fixed role names, so the key is identical every run. AssistantGroup always passes a chainKey, so the per-mount random fallback never applies. STEP_FIRST_SEEN lives for the whole renderer session.

**Evidence.** AssistantGroup.tsx:260 `groupId = group[0]?.id` and :331 `chainKey={`${groupId}-a${activityN - 1}`}`. ThreadActivity.tsx:166-167 uses the fallback only when chainKey is undefined; :310 builds the id `${chainScope}:thinking:${i}`. corp-child-bridge.ts:34 `corpChildId = (nodeId) => `corp:${nodeId}``, :56 `assistantId = `${childId}:turn``, :62 turn 0 gets exactly that id. The ids are deterministic: corp-mesh.ts:726 `id: 'manager'`, :84 `engineerId = (n) => `engineer:${n}``, corp-store.ts:380 `id: 'ceo'`. activity-chain.tsx:1410-1421: the module-level STEP_FIRST_SEEN returns the prior start for a known id, and thinking steps carry no startedAt (activity-mapping mapThinkingStep).

### unverified [low] Audio handover now pops a border and background in a single frame
`apps/desktop/src/styles/global.css:6815`

**Scenario.** On every generate_music, generate_speech or sfx in chat (and in the Audio studio), the pending strip is now borderless with no background. After the bars resolve (AudioPending onResolved, then swept), onRevealed swaps in ThreadMedia's audio card, whose .pd-media-frame has the 1px border and the sunken/raised background. Both appear at once. Before this wave the transparent-border rule covered only image and video, so the pending audio frame already wore the final chrome and the swap was seamless.

**Evidence.** global.css:6806-6808 `.pd-media-card--pending .pd-media-frame { border-color: transparent; background-color: transparent; ... }` now applies to every kind. The only rule that restores the chrome excludes audio: global.css:6815 `.pd-media-card--pending[data-revealing="true"]:not([data-kind="audio"]) .pd-media-frame`. The final frame is global.css:3685-3693 (`background: var(--pd-bg-sunken, var(--pd-bg-raised)); border: 1px solid ...`) plus 3731 (audio). The audio card never leaves the pending state before the swap: PendingMediaCard.tsx:319 and :336-338, then AssistantGroup.tsx:413 onRevealed hands off to ThreadMedia.

### unverified [low] studio-cards-look probe still asserts the removed .pd-pending-falloff and now fails on every run
`apps/desktop/tests/e2e/studio-cards-look.mjs:106`

**Scenario.** Running studio-cards-look.mjs: the waiting-picture step looks up `.pd-pending-falloff`. This wave deleted that element from PendingMediaCard (the mask moved onto the loader host), so the lookup returns null and `check(pendingPic.falloff === '1', ...)` fails. check() sets process.exitCode = 1, so the probe reports FAILED although the card behaves as designed.

**Evidence.** studio-cards-look.mjs:93 `const fall = card?.querySelector('.pd-pending-falloff');`, :97 `falloff: fall ? getComputedStyle(fall).opacity : null`, :106 `check(pendingPic.falloff === '1', ...)`. harness.mjs:285-290 check() pushes the failure and sets `process.exitCode = 1`. This wave's PendingMediaCard diff removed `<div className="pd-pending-falloff" aria-hidden="true" />`, and the global.css diff removed the `.pd-pending-falloff` rules. The probe was not updated.

### unverified [low] (pre-existing, touched by this wave) Every ResizeObserver callback clears the canvas after the frame was drawn: blank loader while resizing, blank for good under Reduce Motion, and the new field makes the wave jump
`apps/desktop/src/chat/BobbleLoader.tsx:213`

**Scenario.** A chat generate_video card mounts square. When `generating.aspect` arrives, the frame eases aspect-ratio and width over 380 ms. Within each frame the order is: rAF draw, then layout, then ResizeObserver, where measure() calls resize(), which sets canvas.width and clears the bitmap, then paint. So the loader shows blank for the whole transition, and during any column resize. Under Reduce Motion the observer's first notification clears the only frame ever drawn, so the fill loader is blank for the card's whole life. New in this wave: each callback also recomputes `field`. Its integer steps change reachFor(), so the cascade/exit line jumps position and whole columns pop in or out at each step.

**Evidence.** BobbleLoader.tsx:199-204 resize() assigns canvas.width/height, which clears the canvas even when the value is unchanged. :207-213 measure() sets `field = fieldFor(...)` and calls resize() with no redraw. :216-217 registers the RO. :315 stops the loop after one frame under reduced motion. The frame transition is at global.css:6809-6813 (aspect-ratio/width 380ms). bobble-anim.ts:428-431 `reachFor = BOARD + (field.x + field.y) * step + ...` feeds cascadeT and exitT.

### unverified [low] (pre-existing) A finished loader that is scrolled out of view and back starts an endless rAF loop
`apps/desktop/src/chat/BobbleLoader.tsx:324`

**Scenario.** A chat card's live preview triggers the exit and the sweep completes (finished = true, running = false). The card stays mounted for the rest of the generation. If the user scrolls it away and back, the IntersectionObserver sets running = true and schedules draw. draw sees p = 1, but `finished` is already true, so it never sets running = false again, and because exitStarted is defined it reschedules itself every frame. It keeps clearing and drawing an empty canvas and writing --pd-bobble-sweep and --pd-pending-sweep, invalidating styles every frame, until the card unmounts. This now also applies to video cards, which went live in this wave.

**Evidence.** BobbleLoader.tsx:245-248 sets `running = false` only inside `if (p >= 1 && !finished)`. :324-326 `if (visible && !running) { running = true; raf = requestAnimationFrame(draw); }`. :315 reschedules while `running && (!reduced || exitStarted !== undefined)`. :243-244 set the style property and call onSweep every frame.

## gen-hyperframes-open
### unverified [medium] Cancelling a HyperFrames render (chat delete, guardian shed, Stop) still produces a joined APNG and ends the job as 'done'
`apps/desktop/electron/gen/hyperframes-still.ts:268`

**Scenario.** A generate_video HyperFrames job is running, e.g. 1280x720 for 5 s at 24 fps. After about 10 frames the user deletes the chat (cancelJobsOf → gen:cancel), or the guardian runs shedRunning('stopped: only 7% of memory was free'). jobQueue.cancel aborts the controller. The renderer leaves its loop at the abort check, then keeps going: it runs the identical-frames check, joins the 10 captured frames into <outputDir>/animation.png and resolves with a success output. JobQueue.#finish only maps REJECTIONS after an abort to 'canceled', so this success is marked 'done'. gen-manager then sends gen:update status 'done', writes poster.png, and returns success to the bridge. The tool (if the pi is still waiting) reads 'Generated 1 animation — 10 frames at 24 fps (0.4 s), looping'. So a job the user or the guardian stopped is reported as a successful render. The guardian's stop reason never reaches anyone. A deleted chat's job writes new files (a full APNG pass over every captured frame, plus a poster) after the delete that was meant to stop it instantly.

**Evidence.** hyperframes-still.ts:268 `if (signal?.aborted === true) break;` and then, with no further abort check, :324-327 `const animation = …; await assemble(frames, animation, fps); return [output(animation, true)];` (the join also has no signal). The runner contract at packages/gen-service/src/job-queue.ts:22 says 'Runs a single job to completion. Rejects on error/abort.' job-queue.ts:366-376 #finish maps `result.ok` → setStatus 'done' + resolve, and only rejections to 'canceled' with cancelReason. gen-manager.ts handleGenerateVideo: after `.result` resolves it runs send('gen:update', payload('done')) and `posterFramePath = await extractPoster(first.outputPath, outputDir)`. The test 'stops between frames when aborted, and still returns one output' (hyperframes-still.test.ts:286) builds this in, even though the queue, the guardian (shedRunning) and chat delete (chat-jobs.ts cancelJobsOf) all expect an aborted runner to reject. Returning partial frames on abort predates this wave. The wave added the APNG join (and relies on cancel for the new delete-stops-everything behaviour).

### unverified [low] Open with an app given as an .app path that is no longer installed says the FILE is gone
`apps/desktop/electron/canvas/os-open.ts:148`

**Scenario.** An Open-with entry's id is an .app path. That happens when readBundleInfo fell back (canvas-main.ts:892 `{ id: appPath }`, :932 `info.id || appPath`) or for a legacy .app id. The per-extension app list (openAppsByExt) is cached for the life of the process, so an app that has since been uninstalled or moved is still offered. The user picks it for report.md. `open -a /Applications/Foo.app /…/report.md` fails, and the real macOS stderr (verified on this Mac) is: 'The application /Applications/Foo.app cannot be opened for an unexpected reason, error=Error Domain=NSCocoaErrorDomain Code=260 "The file “Foo.app” couldn’t be opened because there is no such file." …'. describeOpenFailure tests /does not exist|no such file/ FIRST for every request kind, so the toast reads "Couldn't open report.md in Foo. It is not there any more — it may have been moved or deleted." report.md is on disk. The missing thing is the app. The user is told to look for a file that is fine.

**Evidence.** os-open.ts:148-150 `if (/does not exist|no such file/i.test(text)) return 'It is not there any more — it may have been moved or deleted.';` runs before the app-not-found branch at :151-155, which only matches 'unable to find application|LSCopyApplicationURLsForBundleIdentifier'. Measured: `/usr/bin/open -a /Applications/NoSuchApp12345.app <file>` → exit 1 with the NSCocoaErrorDomain Code=260 '…there is no such file' text above. `open -a NoSuchApp12345` → "Unable to find application named 'NoSuchApp12345'". The unit test (os-open.test.ts:142) feeds an invented stderr ("Unable to find application named 'Blender'") for an .app PATH request, which real `open` does not print for a path, so the misclassification goes untested.

### unverified [low] A 60 s `open` timeout shows the raw 'Error: Command failed: open …' line; the 'did not answer in time' branch never matches
`apps/desktop/electron/canvas/os-open.ts:168`

**Scenario.** The user picks an app from Open with that is slow to take the file, e.g. a cold first launch behind Gatekeeper's dialog left open for more than 60 s. execFile kills `open` with SIGTERM. The error Node produces has message 'Command failed: open -a /Applications/X.app /Users/…/file\n', empty stderr, and signal 'SIGTERM' only as a property. canvas-main passes String(error) as the detail. describeOpenFailure's /timed out|ETIMEDOUT|SIGTERM/ test does not match. The toast becomes "Couldn't open file.png in X. Error: Command failed: open -a /Applications/X.app /Users/…/file.png": an engineer's command line, not the intended 'The app did not answer in time.' Also, as runOpen's own comment notes, killing `open` does not cancel the launch, so the file often appears right after the failure toast.

**Evidence.** canvas-main.ts:702 `execFile(bin, argv, { timeout: 60_000 }, …)`; canvas-main.ts:680 `const detail = (error as { stderr?: string }).stderr?.trim() || String(error);`; os-open.ts:168 `if (/timed out|ETIMEDOUT|SIGTERM/i.test(text)) return 'The app did not answer in time.';`, which falls through to :171, returning the first line. Measured with Node: execFile('sleep',['5'],{timeout:200}) → {msg:'Error: Command failed: sleep 5\n', stderr:'', signal:'SIGTERM', killed:true}. Neither text nor stderr contains 'SIGTERM' or 'timed out'.
