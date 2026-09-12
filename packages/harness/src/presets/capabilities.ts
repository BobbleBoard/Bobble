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
import {
  CHROME_TOOL_NAMES,
  MAC_COMPUTER_USE_TOOL_NAMES,
} from '@pi-desktop/mac-computer-use/tool-names';
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
    /*
     * NAME THE REQUEST, not just the ability. the user asked for the Mac tools to be
     * "described as computer use so it knows when the user asks for 'use this
     * app' it can do that" — and in bash-CLI mode this one line is ALL the model
     * gets about the group, because the capability section that spells it out is
     * stripped there. So the phrasings a person actually uses have to be in the
     * summary itself.
     */
    summary:
      "Computer use: see and control any app on the user's Mac — its windows, menu bar, and its " +
      'own dialogs, sheets and file pickers — plus their own Chrome. "Use <app>", "open <app> and…", ' +
      '"do it in <app>", "click that", "type it in there".',
    guidance:
      "For work inside the user's OWN applications — Notes, Finder, Photoshop, a game — and " +
      'for their own browsers (Safari, Chrome, Arc) when they ask for those specifically. A web ' +
      "page in any of them comes back as TEXT from the ordinary snapshot — the page's own " +
      'headings, prices and labels, each with the point to click it — so read a page that way ' +
      'first rather than reaching for a screenshot. (The chrome_* tools read the real DOM, but ' +
      'they need a Chrome setting that is off by default and that only the user can turn on, so ' +
      'they usually fail; the snapshot needs nothing.) The window AROUND the page — which tabs ' +
      'are open, switching between them, opening and closing one — is mac_tabs / mac_tab, and no ' +
      'page can tell you any of it. An app that ' +
      'exposes nothing to Accessibility returns a screenshot automatically; act by x,y then. A ' +
      'save sheet or file picker is part of the app that opened it — same snapshot, same clicks. ' +
      'A third of what an app can do is in its menu bar, which is in no window: mac_click takes ' +
      'menu:"File > New". It runs in the background — the app never comes to the front. Document ' +
      'commands (Save, Bold, Close) are the exception: macOS runs those only for the frontmost ' +
      'app, so pass activate:true to borrow the focus for one command. Open an app with the ' +
      'launch here, NEVER with `open -a` in a shell — that yanks it in front of whatever the ' +
      'user is doing.',
    tools: [...MAC_COMPUTER_USE_TOOL_NAMES],
  },
  {
    /*
     * the user: "instead of integrating into mac, add a chrome connector and have
     * chrome be its own set." A browser is not just another app you click at.
     * It has tabs, an address bar, a page, and the user's own logged-in
     * session — and folding that into the generic Mac tools made a model asked
     * to work "in Chrome" reach for `mac` and find nothing about any of it.
     */
    name: 'chrome',
    summary:
      "The user's OWN Google Chrome — its open tabs, the page in front, and their logged-in " +
      'session. "in my browser", "the tab I have open", "switch to that tab".',
    guidance:
      'For work in the browser the USER already has open, with their logins and their tabs — ' +
      "not the app's built-in browser (that is `browser`). chrome_tabs lists what is open and " +
      'chrome_tab switches between them; SWITCHING is invisible to the user, but OPENING or ' +
      'CLOSING a tab brings Chrome to the front and cannot be undone, so prefer switching. ' +
      "Read a page with a snapshot: it carries the page's own text with the point to click on " +
      'each line, so a page can be read and driven without a screenshot and without any Chrome ' +
      'setting. Everything else about the window — profiles, settings, the toolbar — is ' +
      'ordinary computer use on the Chrome app.',
    tools: [...CHROME_TOOL_NAMES],
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
    /* MEASURED: with this line present AND the standing "imaging libraries …
       are not how this works" below it, a 2B asked for a picture still probed
       the shell, found Pillow, and wrote a script that draws the subject out of
       rectangles. So the line names the mistake directly — and handmade-media.ts
       catches it at the write, because a line among nine abilities does not
       outweigh what a model already knows how to do. */
    summary:
      'Create images, video, speech, music and sound effects on-device. Every request for a ' +
      'picture, a clip or a sound goes here — never draw or synthesise one in code.',
    guidance:
      'Use when the deliverable IS the media, rather than a description of it. NEVER write a ' +
      'script that draws a picture or synthesises a sound (Pillow, cairo, wave, ffmpeg): a ' +
      'drawing library makes the shapes you described, this makes the thing itself. Code is ' +
      'right for a CHART or a diagram, which is a rendering of data and not a picture of ' +
      'something. For a picture that has to be GOOD rather than merely produced, commission ' +
      'the image specialist with spawn_subagent instead — it works in passes and keeps the best.',
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
    name: 'svg',
    /* MEASURED: with "Make an SVG — a vector drawing …" a 2B model asked for an
       SVG heart typed <svg><circle …/></svg> into `write` — it knows the markup,
       so "make an SVG" read as "write the file". The line has to say that
       hand-writing the markup is the thing NOT to do, or the command is never
       reached for. */
    /* …and the user, after the first run: "if asked to make a website of some sort
       utilize the svgs firsthand instead of writing its own or if asked for
       simple illustrations even without 'svg' mentioned". So the line names
       the cases where the word never comes up — a site's graphics, "a simple
       illustration" — and says where a site's file goes. */
    summary:
      'Draw any icon, logo, symbol or simple flat illustration as an SVG file — a ' +
      'website\'s graphics too, and whether or not "SVG" was said. One call per graphic; ' +
      '--out puts it in the project (assets/logo.svg). Never write SVG markup yourself.',
    guidance:
      'Every graphic goes through this: icons, logos, symbols, pictograms, simple flat ' +
      'illustrations, and the logo and icons of a site or app you are building — whether ' +
      'or not anyone said "SVG". Draw first, then reference the file (<img src>); never ' +
      'write SVG markup by hand. One call per graphic; describe subject, shape and colour ' +
      'plainly, or hand it a reference image to trace. Photos and realistic pictures are ' +
      'not vectors — those are generation.',
    /* One tool, and in CLI mode it IS the command: `svg <prompt> --image <path>`
       (tool-cli.ts maps generate_svg to an empty path under this group). */
    tools: ['generate_svg'],
  },
  {
    name: 'office',
    /* the user, reading the canvas assessment: "model should not be using
       python-pptx, there is a dedicated subagent for each pptx/docx/xlsx
       creation and editing right?" The pipeline existed and was reachable from
       a corp run only; asked for a deck in chat, the model had bash and a habit
       and looped on `from pptx import Presentation`. So the line says what the
       thing is AND names the habit it replaces — the same finding as the two
       generators above: a line among abilities does not outweigh what a model
       already knows how to type, unless it says so. handmade-office.ts catches
       the rest at the call. */
    summary:
      'Make a real slide deck (.pptx), document (.docx), workbook (.xlsx) or PDF from a brief, and ' +
      'edit or read existing ones. Every deck, report, memo or spreadsheet goes here — never ' +
      'python-pptx, python-docx, openpyxl or hand-written XML, and never `read` on an office file.',
    guidance:
      'office_make takes a brief and returns the finished file, open in the canvas, with a ' +
      'slide-by-slide summary. Put EVERYTHING the file should say into the brief — the facts, the ' +
      'numbers, the names, the sections in order — because the pipeline writes only what it is ' +
      'given. office_edit changes wording, style, position or slide order in a file that exists; ' +
      'office_inspect reads one as an outline with ids. Never write these formats with a library ' +
      'or by assembling XML: the pipeline owns the format so the file opens and stays editable.',
    tools: ['office_make', 'office_edit', 'office_inspect'],
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
