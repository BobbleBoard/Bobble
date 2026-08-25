/**
 * Toolset presets: map each task class → a preset tool list.
 *
 * On classification the harness calls `pi.setActiveTools(resolved)` so the model
 * only sees the tools relevant to the task (never the full registry at once).
 *
 * Presets declare *desired* tool names. Many category tools (image/video/3d gen,
 * browser automation) do not exist in v0.1, so {@link resolvePresetTools}
 * intersects the desired list with the tools actually registered in the session
 * and always keeps `tool_search` available. Categories whose tools are not yet
 * present therefore degrade gracefully to tool-search-only.
 */

import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import { MAC_CONNECTOR_TOOLS } from '@pi-desktop/mac-connectors/tool-names';
import type { TaskClass } from '../classify/classify.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../subagent/types.js';

/** The always-available tool-search tool name. */
/**
 * The always-present discovery tool. It WAS `tool_search`; the user had it removed
 * ("a source of much looping") in favour of a named capability group, which is a
 * fixed set turned on in one call rather than a scored free-text query.
 */
export const TOOL_SEARCH_TOOL_NAME = 'capability';

/**
 * The dispatcher that CALLS what a capability named. It travels with
 * {@link TOOL_SEARCH_TOOL_NAME} and must never be advertised without it.
 *
 * MEASURED, and the reason this constant exists: `capability` was advertised and
 * `use` was not, so the model was told it could reach `mac_snapshot` and then had
 * no way to. It did the only thing left and typed `mac_snapshot` at the SHELL,
 * which aborted. Naming a tool the model cannot call is worse than not naming it.
 */
export const USE_TOOL_NAME = 'use';

/**
 * The browser tools that are ALWAYS advertised — the WHOLE suite.
 *
 * the user asked for navigate by default so "open example.com" never falls to the
 * shell. Shipping navigate ALONE caused the loop he then hit: "it's constantly in
 * a loop of calling browser navigate … it really seems like the models are trying
 * to call browser snapshot or something and then they're getting forced to call
 * browser navigate." So navigate and snapshot shipped together, and the rest of
 * the suite was left to arrive on demand via `capability`.
 *
 * IT COULD NOT ARRIVE. Measured with tests/e2e/browser-click-reach-probe.mjs —
 * one page, one button, 20 requests, reading the tools array llama-server was
 * actually sent. It never changed: tools[17], every time. The transcript:
 *
 *     browser_click {index:1}      → "Tool browser_click not found"
 *     capability {name:"browser"}  → "browser is on. You now have: … browser_click …"
 *     browser_click {index:1}      → "Tool browser_click not found"
 *     use {tool:"browser_click"}   → "There is no tool called browser_click"
 *
 * pi's Agent SNAPSHOTS the tool array when a run starts (pi-agent-core
 * agent.js:273, `tools: this._state.tools.slice()`); both the provider request
 * and the tool executor read that snapshot, and `setActiveToolsByName` only
 * mutates state for the NEXT run — pi's own words: "Changes take effect on the
 * next agent turn." An agentic run is one turn, so nothing turned on inside a run
 * can be called during it. That is what produced the nine-snapshot loop in the
 * hive-logbook run, and it means half a browser was never a temporary state.
 *
 * A tool that takes you somewhere and no tool that lets you look is not half a
 * browser, it is a trap; a browser you can look at but never touch is the same
 * trap one rung along. The suite ships together, up front, where it works.
 *
 * the user, on the fix: "let's fix this so it has the manager tool and everything
 * configured correctly from the start … just advertise the right tools."
 */
export const BROWSER_NAVIGATE_ALWAYS = 'browser_navigate';
export const BROWSER_SNAPSHOT_ALWAYS = 'browser_snapshot';
export const ALWAYS_BROWSER_TOOLS = BROWSER_TOOL_NAMES;

/**
 * Harness tools kept active in EVERY preset (when registered), independent of
 * the task class — the model must always be able to publish a plan and ask the
 * user a question. `tool_search` is handled separately (it is gated by
 * {@link ResolvePresetOptions.includeToolSearch}).
 *
 * NOTE: `spawn_subagent` was REMOVED from this list (blind-test item 6). It was
 * front-loaded into every preset, so a small model reflexively spawned a child
 * agent for even a "write a doc" / "create 3 files" task (and those children then
 * over-eagerly drove the browser). It is now front-loaded only for genuinely
 * multi-step classes ({@link SUBAGENT_PRESET_CLASSES}); every other class still
 * reaches it on demand via `tool_search` (it stays globally registered).
 *
 * read/write/edit/bash are ALSO always-active (the user): the model kept disclaiming
 * an ability it ships ("I can't read/write/edit files") whenever it landed in a
 * class whose preset omitted them (simple-QA, basic-tools, other, browser-use,
 * 2d-art, …). Handing it the file tools in EVERY class removes the refusal at the
 * source. These four are self-sufficient — `bash` covers ls/find/grep navigation
 * — so a model can locate, read, and edit files in any conversation. They're the
 * same set every turn, so (with the prefix-cache fix) they never churn the cache.
 * Tradeoff accepted: browser-use had deliberately dropped `read` as an attractive
 * nuisance; the global "never refuse a file op" guarantee outweighs it, and the
 * browser tools are still front-loaded so they read as the primary path there.
 */
export const CORE_FILE_TOOLS: readonly string[] = ['read', 'write', 'edit', 'bash'];
export const ALWAYS_ACTIVE_TOOLS: readonly string[] = [
  ...CORE_FILE_TOOLS,
  'update_plan',
  'ask_user',
  /*
   * `present` is the LAST act of any task that made something, so it has to be
   * reachable from every class — a page, an image, a script and a game land in
   * four different presets and all of them need to hand the thing over.
   *
   * Caught the same way `use` was: it registered fine and appeared in NO preset,
   * so the model never saw it. Registered is not advertised, and llama-server's
   * grammar can only emit a name that is in the advertised list. It is filtered
   * against what is actually registered below, so a build without the desktop
   * bridge simply never lists it.
   */
  'present',
  /*
   * THE GENERATION TOOLS, on every turn — the same argument `WEB` won.
   *
   * the user: "from the chat interface, these backends should be connected. I should
   * be able to go to a new chat and ask for any of these types of media."
   *
   * They cannot arrive any other way. The per-turn class is HARDCODED to
   * 'coding' (index.ts: `preset === 'auto' ? 'coding' : …`) because semantic
   * tool preload was removed on purpose — it churned the KV prefix — so no
   * class-based preset for image, video, 3D or audio is ever selected. And the
   * capability route cannot finish the job either: `use` dispatches through the
   * harness's OWN registry and every extension gets its own api object, so
   * `use({tool:'generate_speech'})` answers "cannot be called this way" exactly
   * as `browser_click` and `mac_click` did. MEASURED, on a real turn: the model
   * discovered the capability, activated it, called `use`, and was refused.
   *
   * Five names on every prefix is a real cost, and it is the same trade `WEB`
   * makes: STABLE (never varies with the wording of a message, so the prefix is
   * still reused) and filtered against what is registered below, so a build
   * without gen-tools lists none of them.
   */
  'generate_image',
  'generate_video',
  'generate_speech',
  'generate_music',
  'generate_sfx',
  /*
   * A CEO COMMISSIONS. the user: "it should always have the commission tools…
   * that's what we wanted right, clean context ceo, until really needed for
   * testing, no clutter with browser tools or anything (it can have the basic
   * tools + search though always) and then it calls subagents to do browser use
   * screenshots extraction of [a site's] ui, or research otherwise or image
   * generation or motion graphics… it commissions, it's a CEO. have it act like
   * one!"
   *
   * MEASURED, runs 10-12: told to close its unknowns before briefing its
   * manager, the CEO delegated immediately every time. It had no way to look
   * anything up — a `coding` turn front-loaded fs+bash+python and nothing else,
   * and `capability` only lands from the NEXT reply, so research cost a turn
   * while delegating cost none.
   *
   * Search and a way to hand work out are therefore not a task class, they are
   * the baseline. Everything HEAVY still stays out — browser, image, video,
   * motion, 3D, perception, connectors — because a subagent does that work in
   * its own context and returns the answer. That is what keeps the CEO's own
   * context clean while making "go and find out" something it can actually do.
   */
  'web_search',
  'web_fetch',
  // The CONSTANT, not the string it happens to equal: this list and the tool's
  // own registration have to move together, and a literal lets them drift
  // silently. The import was already here, unused, for exactly this reason.
  SPAWN_SUBAGENT_TOOL_NAME,
];

/**
 * Classes whose work is genuinely multi-step / parallelizable enough to warrant
 * front-loading `spawn_subagent`. The trivial tiers and single-artifact create
 * tasks (simple-QA, basic-tools, file-ops, 2d-art, other) deliberately OMIT it so
 * the model doesn't reach for a subagent on a one-file / one-answer task
 * (blind-test item 6). Any class can still pull it in via `tool_search`.
 */
export const SUBAGENT_PRESET_CLASSES: ReadonlySet<TaskClass> = new Set<TaskClass>([
  'coding',
  'browser-use',
  'motion-graphics',
  'advanced-video',
  'video-edit',
  'perception',
  '3d',
]);

// Common tool clusters (built-in pi tools + this repo's web-tools/gen tools).
const CORE_FS = ['read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
const WEB = ['web_search', 'web_fetch'] as const;
const PYTHON = ['python_run'] as const;
// The browser set is imported from browser-use (single source of truth) so a
// tool rename is a COMPILE error here, not a silent runtime miss. It leads with
// browser_navigate then browser_snapshot — the model MUST be able to SEE the
// page (snapshot) before it can click/type. (Round-10 bug #9: this list had
// drifted to non-existent `browser_eval`/`browser_screenshot` and omitted
// `browser_snapshot`/`browser_read`, so browser tasks looped, blind.)
const BROWSER = BROWSER_TOOL_NAMES;
// The macOS personal-info connectors (Calendar / Reminders / Contacts / Mail /
// Messages), imported from the connector package so a rename is a COMPILE error
// here, not a silent runtime miss (same discipline as BROWSER). These are the
// tools the model needs for "what's on my calendar", "text mom", "any new mail"
// — the class of request that was previously routed to a tool-search-only preset
// and so drew "I can't access your calendar" refusals.
const MAC_CONNECTORS = MAC_CONNECTOR_TOOLS;
// The REAL registered names come first: `generate_image` / `edit_image` are the
// on-device image tools (tools/image-tools.ts, and gen-tools' generate_image).
// `image_generate` / `image_edit` are legacy placeholders that no tool has ever
// registered — kept only so an older preset name still resolves if one appears.
// Without the real names here, an "draw me a …" turn classified as 2d-art front-
// loaded NOTHING (resolvePresetTools filters to available tools) and the model
// had to rediscover its own image tools through tool_search.
const IMAGE_GEN = ['generate_image', 'edit_image', 'image_generate', 'image_edit'] as const;
const VIDEO_GEN = ['video_generate', 'video_edit'] as const;
const MOTION_GEN = ['motion_graphics_render'] as const;
const THREE_D_GEN = ['model_3d_generate', 'model_3d_view'] as const;
/*
 * The audio generation family. Filtered by `available` like every other group,
 * so a build without gen-tools simply advertises none of them.
 */
const AUDIO_GEN = ['generate_speech', 'generate_music', 'generate_sfx'] as const;
// Typed ffmpeg façade (safe argv, no denoise) — the video-edit preset core.
const VIDEO_EDIT = ['video_edit', 'extract_frames', 'probe'] as const;
// On-device perception: Falcon-Perception (MLX) + ffmpeg-sampled video locate.
const PERCEPTION = ['image_segment', 'image_detect', 'video_locate', 'image_ocr'] as const;

/**
 * Desired preset tool lists per class. `tool_search` is appended by
 * {@link resolvePresetTools} and omitted here to keep the intent readable.
 */
export const PRESET_TOOLS: Record<TaskClass, readonly string[]> = {
  // Tiers.
  'simple-QA': [],
  'basic-tools': [...PYTHON, ...WEB],
  // Categories.
  // WEB lives in ALWAYS_ACTIVE_TOOLS now — every turn can look something up.
  coding: [...CORE_FS, 'bash', ...PYTHON],
  'file-ops': [...CORE_FS, 'bash'],
  // NOTE: the bare file `read` tool is deliberately NOT here — it was an
  // attractive nuisance that a small model grabbed ("Read a file") instead of
  // browsing. Page reading is browser_read; page perception is browser_snapshot.
  'browser-use': [...BROWSER, 'web_fetch'],
  'motion-graphics': [...MOTION_GEN, ...IMAGE_GEN],
  // advanced-video = GENERATION (text→video). Preset unchanged by the video split.
  'advanced-video': [...VIDEO_GEN, ...IMAGE_GEN],
  // video-edit = the ffmpeg façade + fs tools; video_locate bridges to perception.
  'video-edit': [...VIDEO_EDIT, ...CORE_FS, 'video_locate'],
  // perception = analysis (segment/detect/locate/ocr); video_edit burns overlays.
  perception: [...PERCEPTION, 'video_edit'],
  '3d': [...THREE_D_GEN, ...IMAGE_GEN],
  '2d-art': [...IMAGE_GEN],
  // Audio gets its class, for the same reason image and video have theirs: the
  // tools are in hand on the FIRST turn, rather than after a capability
  // round-trip the user has to sit through.
  audio: [...AUDIO_GEN],
  // A GENUINE macOS personal-app request (calendar/mail/messages/contacts/
  // reminders keywords → the 'connectors' class, classify.ts). Front-load the
  // connectors so "what's on my calendar" / "any new mail" / "text mom" has the
  // tool in hand rather than disclaiming it (the round-* refusal bug). Reached
  // ONLY by those keywords — never the generic fallback.
  connectors: [...MAC_CONNECTORS],
  // 'other' is the GENERIC FALLBACK (no tool signal, no dominant modality) plus
  // integration/mcp requests (notion/slack/jira/mcp keywords). Tool-search-only:
  // front-loading nothing keeps a plain "hi" / "list the tools" / open-ended turn
  // at the minimal set (the always-active file tools + tool_search), instead of
  // the 10 personal-info connectors it used to drag in on EVERY no-signal query.
  // Anything genuinely needed is one tool_search away.
  other: [],
};

export interface ResolvePresetOptions {
  /**
   * Keep tool_search available (recommended). Default true — tool-search is
   * "always available" so the model can pull in tools the preset missed.
   */
  readonly includeToolSearch?: boolean;
}

/**
 * Resolve a class's preset against the tools actually registered in the session.
 *
 * - Keeps only desired tools that exist in `availableToolNames`.
 * - Always appends `tool_search` (when present) so tool-search stays available.
 * - De-duplicates while preserving preset order.
 *
 * An empty result (e.g. `simple-QA`, `other`, or a category whose gen tools are
 * absent) collapses to tool-search-only.
 */
export function resolvePresetTools(
  cls: TaskClass,
  availableToolNames: readonly string[],
  opts: ResolvePresetOptions = {},
): string[] {
  const { includeToolSearch = true } = opts;
  const available = new Set(availableToolNames);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const name of PRESET_TOOLS[cls]) {
    if (available.has(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  // `capability` and `use` are a PAIR — one names tools, the other calls them.
  // Either alone is broken, so they are added together or not at all.
  if (includeToolSearch) {
    /*
     * BROWSER IS NO LONGER GLUED TO EVERY TURN. It used to ride along with
     * `capability`/`use` on every class, which is precisely the clutter the user
     * called out: "no clutter with browser tools or anything… it calls
     * subagents to do browser use screenshots extraction… it commissions, it's
     * a CEO." A subagent drives a browser in its OWN context and returns the
     * answer; the browser-use class still front-loads the suite for a turn
     * whose whole job IS driving a page.
     */
    for (const name of [TOOL_SEARCH_TOOL_NAME, USE_TOOL_NAME]) {
      if (available.has(name) && !seen.has(name)) {
        out.push(name);
        seen.add(name);
      }
    }
  }
  /*
   * HANDING WORK OUT IS BASELINE, not a privilege of certain task classes.
   * It used to be gated to SUBAGENT_PRESET_CLASSES, so whether the model could
   * commission anything depended on how a keyword classifier read the prompt —
   * and that is how a CEO told to "research it, commission specialists" ended
   * up with no way to do either (runs 10-12). It is in ALWAYS_ACTIVE_TOOLS now.
   */
  // Plan + ask-user stay active across every class (when registered) so the
  // model can always surface progress and ask questions.
  for (const name of ALWAYS_ACTIVE_TOOLS) {
    if (available.has(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/** True when the resolved preset is tool-search-only (no domain tools). */
export function isToolSearchOnly(resolved: readonly string[]): boolean {
  return resolved.length === 0 || (resolved.length === 1 && resolved[0] === TOOL_SEARCH_TOOL_NAME);
}
