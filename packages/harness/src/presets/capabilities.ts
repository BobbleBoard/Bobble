/**
 * CAPABILITIES — named groups of tools, and the one tool that turns one on.
 *
 * This replaces `tool_search`. the user: "remove tool search entirely, and instead
 * replace with a 'capability' tool that returns right there as the tool result …
 * the tools can be computer use, mail, calendar, browser etc." And separately:
 * "the tool search isn't great and is a source of much looping right now."
 *
 * WHY SEARCH WAS THE WRONG SHAPE. It took a free-text query and activated
 * whatever scored well, so the same request could yield different tools depending
 * on wording, one tool at a time, repeatedly — and every activation rewrote the
 * prompt's tool block. That is both the looping the user saw and the prefill cost:
 * measured, a manager spent 13 of its turns inside tool_search and handed out
 * nothing.
 *
 * A capability is the opposite: a FIXED, named set, turned on once, in one call.
 * "computer use" always means the same tools. There is nothing to search, nothing
 * to score, and a second call for the same capability is a no-op.
 *
 * ON THE COST. Tool schemas are rendered at the START of the prompt, so changing
 * the active set moves everything after it and the KV cache cannot be reused —
 * one re-prefill per activation. Bounded and rare (a handful per conversation at
 * most) rather than the per-message churn the preload caused, but not free.
 *
 * IT CAN BE MADE FREE, and the user is right that it should be. Two facts, both
 * measured against the live server:
 *   · a tool described only in a RESULT cannot be called — llama-server's
 *     tool-call grammar pins the function name to the advertised list;
 *   · a stable advertised DISPATCHER can carry it: told about `mac_snapshot` in
 *     prose, the model correctly emitted `use({tool:"mac_snapshot",args:{…}})`.
 * So the advertised set never has to change. The one missing piece is execution:
 * pi hands out tool definitions WITHOUT their `execute`, and a tool_call handler
 * may block but not rewrite a name — so `use` currently has nothing to dispatch
 * through. The fix is ours to make: the harness loads before web-tools,
 * browser-use and the mac extensions, so wrapping `pi.registerTool` captures
 * every definition (execute included) as it is registered, and `use` dispatches
 * through that. Then activation is pure text and costs nothing.
 */
import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import { MAC_COMPUTER_USE_TOOL_NAMES } from '@pi-desktop/mac-computer-use/tool-names';
import { MAC_CONNECTOR_TOOLS } from '@pi-desktop/mac-connectors/tool-names';

/** The tool that activates a capability — named here so prompt + runtime agree. */
export const CAPABILITY_TOOL_NAME = 'capability';

export interface Capability {
  /** What the model asks for. Lowercase, hyphenated, guessable. */
  readonly name: string;
  /** One line: what it is FOR. Shown when the model lists capabilities. */
  readonly summary: string;
  /** When to reach for this one rather than a neighbour. */
  readonly guidance: string;
  readonly tools: readonly string[];
}

/**
 * The capabilities on offer.
 *
 * Grouped the way a person would ask for them, not the way the code is organised
 * — "calendar, mail and reminders" is one thing to a user even though it is five
 * connectors, and the user asked for exactly that bundling.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    name: 'browser',
    summary: "Drive the app's own built-in browser: navigate, click, type, read a page.",
    guidance:
      'Your PRIMARY web control. browser_navigate and browser_snapshot are always in your ' +
      'list; this adds the rest — click, type, scroll, read, wait, back, forward, key. Never ' +
      're-navigate to a page you are already on just to look at it: snapshot it. If a tab is ' +
      'already open, act on THAT tab rather than opening another.',
    tools: [...BROWSER_TOOL_NAMES],
  },
  {
    name: 'computer-use',
    summary: "See and control any app on the user's Mac, plus their own Chrome.",
    guidance:
      "For work inside the user's OWN applications — Notes, Finder, Photoshop, a game — and " +
      'for their own browsers (Safari, Chrome, Arc) when they ask for those specifically. For ' +
      'Chrome prefer the chrome_* tools: they read the real DOM instead of pixels. An app that ' +
      'exposes nothing to Accessibility returns a screenshot automatically; act by x,y then.',
    tools: [...MAC_COMPUTER_USE_TOOL_NAMES],
  },
  {
    name: 'personal',
    summary: "The user's Calendar, Mail, Reminders, Contacts and Messages.",
    guidance:
      'Call these DIRECTLY for "what\'s on my calendar", "remind me to…", "email…", "text…", ' +
      "or anything needing today's date. Never read a file to work out the date, and never " +
      'drive the Calendar or Mail UI with computer use when a connector answers.',
    tools: [...MAC_CONNECTOR_TOOLS],
  },
  {
    name: 'web-research',
    summary: 'Search the web and fetch a page as readable text.',
    guidance:
      'Search to FIND things, fetch to read one quickly. When you need to interact with a page ' +
      'rather than just read it, activate the browser capability instead.',
    tools: ['web_search', 'web_fetch'],
  },
  {
    name: 'generation',
    summary:
      'Create images, video, speech, music and sound effects on-device — including ' +
      'reading text aloud and cloning a voice from a short sample.',
    guidance:
      'Use when the deliverable IS the media, rather than a description of it. For a picture ' +
      'that has to be GOOD rather than merely produced, commission the image specialist with ' +
      'spawn_subagent instead — it works in passes and keeps the best one.',
    /*
     * ONLY WHAT IS REGISTERED. This listed nine names; four existed. `image_generate`,
     * `image_edit`, `video_generate`, `video_edit`, `extract_frames`, `probe` and
     * `motion_graphics_render` were aspirational — activating this capability handed
     * the model seven tools it could not call, and (per the coercion this codebase has
     * measured twice) a bid for one of them lands on whichever advertised name is
     * nearest. the user: "you can remove things from being explicitly in the ui gallery
     * card." So: the four that a real extension registers, and nothing else.
     */
    /*
     * AUDIO ADDED. The three audio tools were registered by the gen-tools
     * extension and reachable through `use`, but this capability's summary said
     * "images, video, motion graphics and 3D models" and its list named none of
     * them — so a model asked to read a sentence aloud answered, correctly from
     * what it could see, "I don't have a speech or text-to-speech tool
     * available." MEASURED: exactly that reply, on a real turn.
     *
     * Same rule as the note above — only names a real extension registers.
     */
    tools: [
      'generate_image',
      'edit_image',
      'generate_video',
      'generate_speech',
      'generate_music',
      'generate_sfx',
    ],
  },
  {
    name: 'connectors',
    summary: 'Anything reachable over MCP — Notion, Slack, Jira, and whatever else is installed.',
    guidance:
      'List what is connected first, read the schema of the one you want, then call it. The set ' +
      'depends on what this user has installed, so never assume a particular service is there.',
    tools: ['mcp_list', 'mcp_schema', 'mcp_call'],
  },
];

/** Look one up by name, tolerantly — "computer use" and "computer_use" both work. */
export function findCapability(name: string): Capability | undefined {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (
    CAPABILITIES.find((c) => c.name === key) ??
    // A near-miss is far more useful than "unknown capability": the model asking
    // for "mail" plainly wants the one that contains mail.
    CAPABILITIES.find((c) => c.name.includes(key) || key.includes(c.name))
  );
}

/**
 * The capability that contains a given tool.
 *
 * Used when the model's stated intent names a tool it has not been given: it
 * wants to click, so it is browsing, so it is about to want type and scroll too.
 * Turning on the whole group costs the SAME single re-prefill as smuggling in the
 * one tool, and saves the next two. the user: "load the capability suite of browser
 * tools when it's called immediately."
 */
export function capabilityForTool(tool: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.tools.includes(tool));
}

/** The menu, for a bare `capability()` call. */
export function capabilityMenu(): string {
  const lines = CAPABILITIES.map((c) => `- ${c.name} — ${c.summary}`);
  return [
    'Capabilities you can turn on, by name:',
    '',
    ...lines,
    '',
    `Call ${CAPABILITY_TOOL_NAME} with one of these names and its tools join your list from ` +
      'your NEXT reply onward — not this one. Turn on only what the task needs.',
  ].join('\n');
}

/**
 * What the model is told when a capability comes on: the tools it now has, and
 * the rule for using them well.
 *
 * `available` filters to what is actually registered in THIS build — naming a
 * tool that does not exist would have the model call into nothing.
 */
export function capabilityActivated(
  cap: Capability,
  available: readonly string[],
  /**
   * The command this capability answers to when the CLI is the interface.
   *
   * IN CLI MODE THERE IS NOTHING TO WAIT FOR. The paragraph below tells the
   * model its new tools are "NOT callable in this reply" — true when activation
   * changes the advertised tool array, and false when every tool is already a
   * command on PATH. Left unchanged it costs a wasted turn: the model stops,
   * announces what it is about to do, and hands back a reply that could have
   * done it. Absent ⇒ the schemas wording, which is the existing behaviour.
   */
  cliCommand?: string,
): string {
  const present = cap.tools.filter((t) => available.includes(t));
  if (present.length === 0) {
    return (
      `The "${cap.name}" capability is not available in this build — none of its tools are ` +
      'installed. Say so plainly rather than pretending to use it.'
    );
  }
  if (cliCommand !== undefined) {
    return [
      `"${cap.name}" is available NOW, as \`${cliCommand}\` — it always was, and it stays. ` +
        `Run \`${cliCommand} --help\` to see what it does.`,
      '',
      'Nothing is pending and nothing changed: these are commands, not a tool list, so use ' +
        'them in THIS reply rather than stopping to announce them.',
      '',
      cap.guidance,
    ].join('\n');
  }
  return [
    `"${cap.name}" is on, and takes effect on your NEXT reply: ${present.join(', ')}.`,
    '',
    'They are NOT callable in this reply — calling one now returns "tool not found". Finish ' +
      'this reply with what you can already do, or stop and say what you are about to do with ' +
      'them; they will be in your tool list from your next reply onward, and stay there.',
    '',
    cap.guidance,
  ].join('\n');
}
