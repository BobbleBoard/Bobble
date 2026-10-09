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
 * THE BROWSER SUITE IS NOT ALWAYS-ON ANY MORE, and this is the note explaining
 * why it was, so nobody puts it back.
 *
 * It was pinned to every turn because `capability` could not deliver it.
 * MEASURED with tests/e2e/browser-click-reach-probe.mjs — one page, one button,
 * 20 requests, reading the tools array llama-server was actually sent. It never
 * changed: tools[17], every time:
 *
 *     browser_click {index:1}      → "Tool browser_click not found"
 *     capability {name:"browser"}  → "browser is on. You now have: … browser_click …"
 *     browser_click {index:1}      → "Tool browser_click not found"
 *     use {tool:"browser_click"}   → "There is no tool called browser_click"
 *
 * The cause was pi's Agent SNAPSHOTTING the tool array when a run starts
 * (pi-agent-core agent.js:273, `tools: this._state.tools.slice()`), so nothing
 * turned on inside a run could be called during it — pi's own words, "Changes
 * take effect on the next agent turn", and an agentic run IS one turn. A tool
 * that takes you somewhere and no tool that lets you look is a trap, so the
 * whole suite shipped up front, on every prefix, forever.
 *
 * That line is patched now (patches/@mariozechner__pi-agent-core: the tools
 * setter mutates in place and the loop shares the live array), so a capability
 * lands inside the turn that asks for it — verified at 14 tools on request 1 and
 * 25 on request 3 of the same turn. The suite goes back behind `capability`,
 * where it costs nothing until it is wanted.
 */

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
 * multi-step work; a one-answer task still
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
   * THE GENERATION TOOLS ARE NOT HERE ANY MORE — same story as the browser
   * suite above.
   *
   * They rode every prefix for one reason: "the capability route cannot finish
   * the job either — `use` dispatches through the harness's OWN registry and
   * every extension gets its own api object, so `use({tool:'generate_speech'})`
   * answers 'cannot be called this way'." MEASURED on a real turn: the model
   * discovered the capability, activated it, called `use`, and was refused.
   *
   * The user's requirement stands — "from the chat interface, these backends should
   * be connected. I should be able to go to a new chat and ask for any of these
   * types of media" — and it is now met the way it was always meant to be: the
   * model activates `generation` and uses it in the SAME turn. Five names come
   * off every prefix in every conversation that never asks for media.
   */
  /*
   * A CEO COMMISSIONS. The user: "it should always have the commission tools…
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
 * THE BASE SET IS THE WHOLE SET. There is no per-task table any more.
 *
 * There used to be a `PRESET_TOOLS: Record<TaskClass, string[]>` — a tool list
 * per guessed task class — and a keyword classifier choosing between them. Two
 * things killed it. The classifier was switched off for TTFT (a tool set that
 * moves with the wording of a message is a prompt prefix that is never reused),
 * so every turn already resolved to the same neutral entry and the table was
 * dead code with fourteen branches. And what it was really working around was a
 * bug: `capability` could not deliver a toolset mid-turn, so anything a task
 * might need had to be guessed up front. That is fixed in pi now (the agent
 * loop shares the live tool array), so a capability turned on during a task is
 * usable during that task — which is the whole reason to have one.
 *
 * The user: "in regular mode some base tools are loaded … then there's the
 * capability tool that loads toolsets needed for tasks … classification has no
 * place here anymore."
 */

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
export function resolveBaseTools(
  availableToolNames: readonly string[],
  opts: ResolvePresetOptions = {},
): string[] {
  const { includeToolSearch = true } = opts;
  const available = new Set(availableToolNames);
  const out: string[] = [];
  const seen = new Set<string>();
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
   * It used to be gated to a set of task classes, so whether the model could
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
