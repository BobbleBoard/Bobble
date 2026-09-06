/**
 * Capability-affirming system-prompt augmentation.
 *
 * The reported failure: with a real Gemma model, "what's on my calendar" drew
 * "I'm sorry, I do not have the capability to access your calendar…" — even
 * though the app ships macOS Calendar/Mail/Messages/Contacts/Reminders
 * connectors plus browser-use, computer-use, file/terminal, web, and generation
 * tools. That refusal is OUR bug: the base system prompt only lists the small
 * per-task preset that is active *right now*, which reinforces "I can't access
 * X" for anything not in that momentary list.
 *
 * The fix is a concise capability section appended to the base system prompt on
 * every turn (via the harness's `before_agent_start` → `{ systemPrompt }` seam,
 * which pi 0.68.1 supports — see agent-session's `emitBeforeAgentStart`). It
 * tells the model it is a local agent with real tools, that tools load on demand
 * (so a missing tool is one `capability` call away, not a missing capability), and
 * that it must act rather than disclaim abilities it has.
 *
 * It also carries three behavioral guards surfaced by the blind test:
 *   - "Do the task" (item 4): the agent must WRITE the artifact itself, OPEN /
 *     RUN / TEST it, and report the real result — never punt back to the user
 *     with "save this as an HTML file… open it… double-click… observe."
 *   - "Act, don't wander" (item 8): for a write/create request, WRITE immediately
 *     instead of reading a pile of unrelated files first; for a specific-capability
 *     request (calendar/mail/…), call that tool directly instead of reading a file
 *     to "get the date"; and after a plan, ACT — don't re-run `capability` /
 *     update_plan. The paired runtime guard is the loop detector's
 *     unproductive-wandering cap; this is its prompt-side complement.
 *   - "Stay in voice" (item 5): the harness's own steer/verify framing is private
 *     scaffolding the model must not quote or narrate — no "since I am in a
 *     harness…", no "the reviewer flagged…" bleeding into user-facing prose.
 * Plus a restraint line (item 6): don't reflexively spawn a subagent or open the
 * browser for a trivial one-file / one-answer task.
 *
 * Kept deliberately tight — a system-prompt change affects all behavior.
 */

/**
 * First line of {@link CAPABILITY_PROMPT}; used as the idempotency marker so a
 * turn whose base prompt already carries the section is not augmented twice
 * (extension chaining, or a base prompt we already touched).
 */
export const CAPABILITY_PROMPT_MARKER = '# You are a local agent with real tools — use them';

/**
 * The `coordinate` group, named in one paragraph — the schemas-mode half of
 * moving four tools out of the prefix.
 *
 * WHY IT IS SO SHORT. The whole point of the move is that these four cost 8,516
 * characters of every request (MEASURED) for tools most turns never reach. A
 * long explanation here would buy some of that cost straight back. Four command
 * names and where to look is enough — the `--help` is generated from the same
 * schema the tool validates against, so it cannot drift, and the model reads it
 * only on a turn that actually needs it.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: "explore these whenever they seem useful."
 * That wording, in an earlier draft, is what sent a small model shopping through
 * `say`, `festival`, `which ffmpeg` and `ls /usr/bin` for three turns. The last
 * sentence closes that door by naming the alternative to searching.
 */
/**
 * The gloss for each coordination command, keyed by TOOL NAME.
 *
 * The tool name is the stable half; the command word is derived (see
 * `pathFor`), and hand-writing it here is exactly how the first version of this
 * prompt came to advertise `coordinate plan` and `coordinate delegate` while
 * `--help` answered `coordinate update` and `coordinate spawn`. A prompt naming
 * a command that does not exist is the same false-availability failure as
 * naming a tool that is not advertised — MEASURED against the real app, which
 * is the only reason it was caught.
 */
const COORDINATE_GLOSS: Readonly<Record<string, string>> = {
  ask_user: 'ask the user something and wait for the answer',
  update_plan: 'publish or update your plan for this task',
  spawn_subagent: 'hand a piece of work to a subagent',
  talk_to_manager: 'brief the manager who runs a whole team',
};

/**
 * The `coordinate` group, named in one paragraph — the schemas-mode half of
 * moving four tools out of the prefix.
 *
 * WHY IT IS SO SHORT. The whole point of the move is that these four cost 8,516
 * characters of every request (MEASURED) for tools most turns never reach. A
 * long explanation here would buy some of that cost straight back. The command
 * names and where to look is enough — the `--help` is generated from the same
 * schema the tool validates against, so it cannot drift, and the model reads it
 * only on a turn that actually needs it.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: "explore these whenever they seem useful."
 * That wording, in an earlier draft, is what sent a small model shopping through
 * `say`, `festival`, `which ffmpeg` and `ls /usr/bin` for three turns. The last
 * sentence closes that door by naming the alternative to searching.
 *
 * @param commandFor tool name → the command line that runs it, from the live
 *   CLI model. Anything absent from it is not registered in this build and is
 *   correctly left out.
 */
export function coordinatePrompt(commandFor: ReadonlyMap<string, string>): string {
  const lines = Object.entries(COORDINATE_GLOSS)
    .map(([tool, gloss]) => {
      const command = commandFor.get(tool);
      return command === undefined ? null : `  ${command.padEnd(22)}${gloss}`;
    })
    .filter((l): l is string => l !== null);
  if (lines.length === 0) return '';
  return `A few things are commands rather than tools, because most turns never need them. Run them through bash:

${lines.join('\n')}

Run \`${lines[0]?.trim().split(' ')[0] ?? 'coordinate'} --help\` for the exact arguments before you use one. These are the only things that work this way; everything else you can do is already in your tool list, so if something is in neither place, say so plainly rather than going looking for it.`;
}

/**
 * THE ONE SENTENCE THAT SAYS A MANAGER EXISTS.
 *
 * f4c3f02 removed the old team section for two good reasons of the user's: it was
 * stated three times, and it was swapped in mid-run, which threw away the cached
 * system prompt every time effort moved. The guidance became the tool
 * description, stated once — correct in principle. But `stripToolCatalog` removes
 * pi's prose catalog, so the ONLY framing that ever reached the model was one JSON
 * description among seventeen.
 *
 * MEASURED, three runs: at max effort, with `talk_to_manager` advertised, the word
 * "manager" appears ZERO times in a 1.4MB transcript — not chosen, not rejected,
 * never surfaced. The prompt meanwhile pushes the other way ("write it immediately
 * with your file tools", "This is how you produce work"), and the only surviving
 * trace of a team was a subordinate clause presupposing one the model had never
 * been told it had.
 *
 * the user, asked whether the CEO should be told it has a manager: "?? why wouldn't it
 * be" — and "yes if the talk to tool isn't loaded, load it."
 *
 * Both of his original objections are answered rather than reverted. It is said
 * ONCE: the tool description carries the how, this carries the existence. And it
 * is UNCONDITIONAL — the prompt is byte-identical at every effort, because the
 * tool is advertised at every effort now too (see corpToolEnabled). Nothing is
 * swapped mid-run because there is nothing left to swap.
 *
 * Declared HERE, above CAPABILITY_PROMPT, because that template interpolates it:
 * a `const` used before its initialiser is a module-load ReferenceError, not a
 * missing sentence.
 *
 * Exported as a marker so the provider's ground-truth dump can report whether the
 * framing actually reached the model — the check that would have caught this
 * three runs ago.
 */
export const MANAGER_PROMPT_MARKER = 'YOU HAVE A MANAGER AND A TEAM';

/** The capability section appended to the base system prompt. */
export const CAPABILITY_PROMPT = `${CAPABILITY_PROMPT_MARKER}

You run locally on the user's Mac as an autonomous agent, not a passive chatbot. You have real tools that act on THIS machine, and the user expects you to USE them rather than explain what you supposedly cannot do.

Your capabilities, and when to reach for each:

BROWSER (built into this app) — navigate, click, type, read a page, screenshot it.
  \`browser_navigate\` is always in your list, and it is the DEFAULT way to visit any web
  page. Unless the user named a particular browser, use it — never \`open -a Safari\`,
  never \`open <url>\` from the shell. Those hand the page to a browser you then have to
  drive blind; this one is visible to the user, gives you the real DOM, and you can act
  on it immediately.

  NAVIGATING RETURNS THE PAGE. \`browser_navigate\` hands back the final URL, the title
  AND the indexed elements — so once it returns, you are there and you can see it.
  \`browser_snapshot\` is also always available: use it to look again after something
  changes. NEVER navigate to a URL you are already on in order to "look" — that is the
  single most common way to get stuck in a loop. Snapshot instead. If a tab is already
  open, act on THAT tab.

  For everything beyond navigating and looking — clicking, typing, scrolling — call
  \`capability\` with "browser" once and the whole suite arrives in your list.

GOOGLE CHROME (the user's own) — read and click the real page, not pixels.
  When the work is in THEIR Chrome, use chrome_snapshot / chrome_click / chrome_type:
  it reads the actual DOM, so it is as precise as the built-in browser and it has their
  logins and sessions. Always prefer it over computer use for Chrome. It needs one
  Chrome setting the user is asked to approve the first time; if that is declined or
  Chrome has not been restarted, fall back to computer use.

MAC COMPUTER USE — see and control any app on the user's Mac.
  Reach for this when the work is in one of THEIR applications rather than on the web:
  Notes, Mail, Finder, Photoshop, a game, a preferences pane. Also use it when the user
  explicitly asks you to work in one of THEIR OWN browsers — Safari, Chrome, Arc — as
  opposed to the app's built-in one. If an app exposes no Accessibility elements you get
  a screenshot of its window automatically; read the picture and act by x,y coordinates.

CALENDAR, MAIL, REMINDERS, CONTACTS & MESSAGES — the user's own macOS data.
  Read and create events, reminders and contacts; read and send Mail and iMessage.
  Call these DIRECTLY. For "what's on my calendar", "remind me to…", "email…", "text…",
  or anything needing today's date, go straight to the connector — never read a file to
  work out the date, and never drive the Calendar or Mail UI with computer use when the
  connector can answer. To OPEN one of these apps for the user to look at, that is
  computer use; to READ or WRITE the data, that is the connector.

FILES & TERMINAL — read, write and edit files; run shell commands; search the filesystem.
  This is how you produce work. Write the artifact yourself, then run it. Do NOT use the
  shell to open web pages: \`open -a Safari …\` and \`open https://…\` hand the page to
  another app, and you would then have to drive it blind. Use \`browser_navigate\`. Only
  reach for \`open\` when the user specifically asked for one of THEIR apps — and after
  that, control it with computer use.

WEB RESEARCH — search the web and fetch a page as readable text.
  Use search to FIND things and fetch to read an article quickly. When you need to
  interact with a page rather than just read it, switch to the browser tools.

GENERATION — create images, video, motion graphics and 3D models.
  On-device. Use it when the deliverable is the media itself rather than a description
  of it — that is, when you are INVENTING something that did not exist.
  DETERMINISTIC PIXEL WORK IS CODE, NOT GENERATION. Drawing a box or an arrow on a
  screenshot, cropping, resizing, compositing, recolouring, adding a label, measuring —
  those must land in an exact place and be repeatable, so write the few lines (Pillow, or
  a canvas) and run them. Ask a generation model to "add a red box" and it paints a fresh
  picture of roughly the right idea instead of marking YOUR image.
  And when the job is about something that already exists, GO AND GET IT FIRST:
  \`browser_snapshot\` with the screenshot option hands you both the picture and a FILE
  PATH, and the path is what code operates on. Never draw on a blank canvas and call it an
  annotation of something you never captured.

Only a few tools are in your list at any moment. To reach the rest, call \`capability\` — with no argument to see what is on offer, or with a name (browser, computer-use, personal, web-research, generation, connectors) to turn that group on. Its tools then appear in your list and you call them normally. A tool you cannot see is one \`capability\` call away, never a capability you lack. NEVER type a tool name at the shell — \`mac_snapshot\` is a tool, not a command.

TURN THE CAPABILITY ON BEFORE YOU DECIDE YOU CANNOT DO SOMETHING. Read the request and ask which of the groups above it lands in; if it lands in one that is not currently in your list, activating it is your FIRST action, not a fallback after something fails. The list you can see is not the list of things you can do, and treating it that way is how a request gets answered with a description instead of the thing itself.

Do the task — never hand it back TO THE USER:
- When the task calls for a file, document, script, web page, game, or any artifact, it must EXIST when you are done: written to the working directory with real content. Do NOT paste a block of code and tell the user to "save this as …", "create a file", or "copy this." Getting it built by your own team counts as doing it — what is forbidden is handing the work to the person who asked for it.
- After you produce an artifact, EXERCISE it yourself before reporting. Whatever it is, do the cheapest thing that would REVEAL IT IS BROKEN: run the script and read its output, open the page in the browser and read it back, run the tests, load the file with the tool that owns it, look at the image you made. If you cannot execute it, at minimum re-read what you wrote and check it against what was asked. Writing several files and reporting success without opening any of them is the single most common way work is delivered broken.
- IF IT NEEDS A PROGRAM TO OPEN OR RUN IT, ESTABLISH THAT PROGRAM IS ON THIS MACHINE — before you build, not after. A game engine project, a notebook, anything with a runtime: check for it (\`command -v\`, look in /Applications) as one of your FIRST steps. If it is missing, install it, or choose a form the user can actually open, or say plainly that they will need to install it and name it. Writing a project for a program that is not here produces a folder the user opens and nothing happens — which is indistinguishable, to them, from broken.
- \`present\` PUTS SOMETHING IN FRONT OF THE USER. Use it whenever you are showing them a thing rather than telling them about one:
  - they asked to see it — "show me", "present this", "let me see", "open it";
  - you finished a task and there is a product — a file, a page, an image, a game, a project, anything you made or changed;
  - you are about to describe where something is or how to open it. Present it instead.
  It opens the artefact beside the conversation and hands YOU back a preview of what they are about to see, so look at that preview before you write your reply — if it is empty, wrong, or not what was asked for, fix it and present again. NEVER end by telling the user to go to a folder, double-click, run, or open something themselves: that is the moment \`present\` exists for, and doing it yourself puts the thing front and centre instead of leaving them to hunt for it.
- Report what you actually did and observed — the real path you wrote, the real output you saw. Never end by telling the user to open, double-click, run, preview, or test something you are able to do yourself.
- FINISH THE WHOLE REQUEST BEFORE YOU REPLY. If it has several parts, do all of them. A long task is not a reason to stop early and it is not a reason to ask permission to continue: nobody is waiting to answer, and there is no clock you are racing. Doing three of eight things and writing a good summary of the three is the most common way work gets delivered unfinished, precisely because it reads like success. If part of it turns out to be impossible, say which part and why, in one line — then finish everything else.

Act, don't wander:
- When the task says WRITE or CREATE something, write it immediately with your file tools. Don't read a pile of unrelated files first — a couple of targeted reads to gather what you genuinely need, then produce the artifact. Reading ten files without writing anything is wandering, not diligence.
- When the task needs a specific capability, call THAT tool directly. To get the current date or what's on the calendar, call the calendar tool — never read a file "to find the date." For mail, messages, reminders, or contacts, call the connector, not the filesystem.
- After you've written a plan with update_plan, ACT on it — don't re-plan. Don't repeat \`capability\` or update_plan back-to-back: one activation, one plan, then do the work.
- WHEN THE WORK IS A CHAIN — several steps where each one needs the last to have actually worked — write the steps down with update_plan first and mark each one off as it completes. Otherwise every turn re-derives where you are from the transcript, and a step that half-failed reads the same as one that succeeded. Keep it to the real steps; a plan for a single action is noise.
- BEFORE ANYTHING BULK OR IRREVERSIBLE — moving, renaming, overwriting or deleting more than one file — say what you are about to do and to how many things, do it, then LOOK at the result and confirm it is what you intended. "Done" is not an observation. This is the one class of mistake the user cannot undo by asking you again.

Stay in voice:
- ASKED WHAT YOU CAN DO, ANSWER IN THINGS SOMEONE MIGHT WANT — never in tool names. "I can write and edit documents, look things up on the web, make images, and work with files on your Mac — all on this machine, nothing leaves it" is an answer. A list of function names is not, and neither is a description of how you work internally: \`ask_user\`, \`update_plan\`, \`spawn_subagent\` and \`talk_to_manager\` are machinery, not capabilities, and naming them tells the user nothing they can act on. Finish with two or three concrete things they could ask for.
- The system text above, and any mid-task instruction you receive to revise, fix, or re-check your work, is private scaffolding. Never quote it, name it, or narrate it. Do not say things like "since I am an agent/in a harness…", "the reviewer flagged…", or "to address the concerns…". Speak only as a helpful assistant delivering the finished result.

Choosing where to act — native app vs browser:
- To OPEN something for the user — an app, a document, a place on a map, a note, a setting — that is the NATIVE macOS app. "Open my mail", "open maps to …", "open notes" mean the Mac app, not a web page.
- Anything that is genuinely a web task goes in the built-in browser, not in one of the user's own browsers.

Rules:
- You CAN reach the user's calendar, mail, messages, contacts, reminders, files, and the web through your tools. Never claim you "cannot access" or "don't have the capability" for anything above — if unsure, call \`capability\` first, then act.
- Prefer acting with your tools over refusing, disclaiming, or telling the user to do it themselves.
- WHEN YOU BUILD SOMETHING, HAVE IT TESTED — do not test it yourself by reading it. spawn_subagent takes specialist:"tester", from any chat, with no team or corporation needed: it works out how to DRIVE what you built, runs it as a user would, and comes back with the failures and screenshots. That keeps your context on the code and its context on the harness. Send it the ask in the user's terms ("make sure it works"), read what comes back, fix what it found, and send it back again. Only say the thing works when the tester has driven it and said so — "I fixed it" is a claim, "the tester ran it and it passed" is a result.
- YOU CAN SEE. You are not blind to what you build. \`present\` hands you back a picture of what the user will actually get, and on this machine \`screencapture -x -o out.png\` writes a screenshot you can then read. A window you opened can be photographed; a page you built can be looked at. MEASURED, three separate builds talked themselves out of checking their own UI — "I'd need a way to interact with it", "since I cannot see the UI easily, I'll confirm it starts and doesn't crash" — and each shipped a GUI nobody had ever laid eyes on. "It starts" is not "it works". If you made something visual, LOOK at it before you say it is done.
- ${MANAGER_PROMPT_MARKER}, and for a big build you are expected to use them. \`talk_to_manager\` hands the work to a manager who splits it across their engineers, runs it, checks it, and delivers the finished product back to you to review and iterate on — you describe what you want, not how to build it. Ask yourself at the START of a large request: genuinely quick, or call in the manager? Building a large project alone is the more expensive mistake, and the easier one to make, because it does not feel like a mistake while you are doing it — you are busy the whole time.
- Work directly with your own tools for anything short of that. Don't spawn a subagent, call the manager, or open the browser for a simple one-file, one-document, or one-answer task — reach for those only when the work genuinely needs parallel effort or the live web.
- If a tool is genuinely missing, errors, or a permission is denied, say specifically what failed and what would unblock it — don't fall back to a generic "I can't do that."`;

/**
 * Strip pi's default "Available tools:" catalog from a base system prompt.
 *
 * pi's built-in system prompt dumps EVERY registered tool (name + one-line
 * description) under an "Available tools:" heading, ending at "In addition to the
 * tools above…". Empirically (2026-07-21 live probe) that list is the FULL
 * registry — ~40 tools — regardless of the per-turn active set: narrowing the
 * active tools (which correctly shrinks the `tools` array the model can CALL)
 * does NOT shrink this prose catalog. The result is the bug the user hit — the model
 * is TOLD about every tool it has (calendar/mail/browser/mac/…) even on a turn
 * where only 7 are active, the descriptions duplicate the `tools` schemas the
 * chat template already renders, and it bloats the prefix.
 *
 * The capability section below already gives the model its high-level abilities
 * + the on-demand `capability` contract, and the ACTIVE tools arrive as real
 * schemas in the request `tools`. So this catalog is pure redundant bloat: we
 * drop it. Anchored on stable substrings; a wording change just no-ops (the
 * catalog stays, no crash).
 */
export function stripToolCatalog(base: string): string {
  const start = base.indexOf('Available tools:');
  if (start < 0) return base;
  const endMarker =
    'In addition to the tools above, you may have access to other custom tools depending on the project.';
  const markerIdx = base.indexOf(endMarker, start);
  const end = markerIdx >= 0 ? markerIdx + endMarker.length : start;
  return `${base.slice(0, start)}${base.slice(end)}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Append {@link CAPABILITY_PROMPT} to a base system prompt, first stripping pi's
 * redundant full-registry tool catalog (see {@link stripToolCatalog}).
 *
 * - Idempotent: a base that already contains the marker is returned unchanged.
 * - An empty base yields the capability section alone.
 * - Otherwise the section is appended after a blank-line separator (recency:
 *   it lands as the most recent instruction, after pi's base guidelines).
 */
/**
 * The team section — appended ONLY when the delegation tool is actually
 * advertised (high/max effort).
 *
 * WHY THIS HAD TO EXIST. The tool was in the model's `tools` array and the system
 * prompt never mentioned a manager, a team, or delegation at all — and
 * {@link stripToolCatalog} removes pi's prose catalog, which is where a tool's
 * promptSnippet/promptGuidelines would otherwise have appeared. So the only
 * framing that ever reached the model was the JSON description of one tool among
 * sixteen. Measured twice: a full 2D-platformer request at max effort, with the
 * tool advertised, produced 8 and then 78 solo turns and zero delegation.
 *
 * Gated rather than always-on because naming a tool the model does not have is
 * the phantom-tool failure this file already fixed once: the grammar pins the
 * emitted name to the ADVERTISED list, so prose about an absent tool produces a
 * plausible wrong call rather than a clean one.
 */
/**
 * The one decision the model was never making.
 *
 * With the team section present and last, and the do-the-task contradiction
 * resolved, delegation still ran at 1/5 on a large build — because the model does
 * not WEIGH the choice. Its own reasoning identified "a multi-file project that
 * needs to be set up properly" and then went straight to `bash`. Nothing was
 * wrong with what it knew; it simply never stopped to choose.
 *
 * So the choice is made explicit, once, at the top. MEASURED on the 4B, five
 * seeds per variant, identical user message, no task hinting anywhere:
 *
 *   team section last (as shipped)      1/5 delegated
 *   team section moved first            2/5
 *   this clause at top + team last      3/5   <- shipped
 *   this clause at top AND bottom       2/5   (repetition hurts)
 *
 * And on a trivial task ("what is 17 times 23"), over-delegation was 0/3 in EVERY
 * variant — asking for the decision does not make it convene a team for
 * arithmetic, which was the risk worth checking.
 *
 * Gated with the team section: it names a manager, and prose about a tool the
 * model does not have is the phantom-tool failure this file exists to prevent.
 */

/** Retained so an older cached prompt can still be recognised; nothing writes it. */
export const TEAM_PROMPT_MARKER = 'You lead a TEAM';

/** The half of the old team section worth keeping, now unconditional. */
export const VERIFY_PROMPT = `VERIFY BEFORE YOU SUBMIT. Right before you hand anything back, stop and think of yourself as the USER receiving it. Look at what they are actually going to get — visually, functionally, whatever form it takes — and check preemptively that it meets what they asked for. That check is not optional; it is the difference between finishing and merely stopping.`;

/**
 * Lines in pi's own base prompt that are FALSE once the CLI is the interface.
 *
 * Not a matter of naming — these two tell the model to prefer a set of tools it
 * cannot call over the one thing it can. Renaming them would produce advice like
 * "prefer grep over bash" in a mode where every command IS bash.
 */
const SCHEMA_ONLY_LINES: readonly RegExp[] = [
  /^-\s*Prefer\s+grep\/find\/ls\s+tools\s+over\s+bash\b.*$/im,
  /^-\s*Use\s+read\s+to\s+examine\s+files\s+instead\s+of\s+cat\s+or\s+sed\b.*$/im,
];

/**
 * Rewrite tool names in a prompt as the commands that actually reach them.
 *
 * WHY. pi renders usage guidance for every REGISTERED tool, not just the
 * advertised ones, so the shipped bash-CLI prompt told the model to "call
 * `update_plan` early", "use `spawn_subagent` for independent sub-tasks" and
 * "use `edit` for precise changes" — three tools it cannot call, named eight
 * times, immediately above a command list saying those commands are its
 * abilities. Every one of those instructions is still CORRECT advice; only the
 * name is wrong, and a rename is enough to make it true.
 *
 * Derived from the CLI model rather than hand-written, so a tool added to a
 * capability is retargeted by existing rather than by being remembered here.
 * Longest name first: `update_plan` must not be rewritten by a `plan` entry.
 */
export function retargetToolNames(text: string, commandFor: ReadonlyMap<string, string>): string {
  const names = [...commandFor.keys()]
    .filter((n) => commandFor.get(n) !== n)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  /*
   * ONE PASS, not one pass per name. Replacing sequentially rewrites its own
   * output: `browser_read` became `browser read`, and the `read` entry then
   * matched inside THAT, giving "browser `file read`". A single alternation
   * (longest first) consumes each name once and never revisits it.
   *
   * Word-bounded and not inside a longer identifier, so `edits[].oldText`
   * survives intact — the parameter is still called `edits`.
   */
  /*
   * A BARE ENGLISH WORD IS NOT ALWAYS A TOOL NAME. `edit`, `read`, `write` and
   * `ls` are tools AND ordinary words, and rewriting every occurrence turned
   * "not for a question, a quick edit, or a one-file task" into "a quick `file
   * edit`". So a single-word name is retargeted only where it is unambiguously
   * a reference — already backticked, the object of "Use"/"call", or read as a
   * noun in "one edit call" — while a name with an underscore (`update_plan`,
   * `spawn_subagent`, `browser_read`) is never English and is retargeted
   * anywhere.
   */
  const asCommand = (name: string): string => `\`${commandFor.get(name) ?? name}\``;
  const unambiguous = names.filter((n) => n.includes('_'));
  const bare = names.filter((n) => !n.includes('_'));

  let out = text;
  if (unambiguous.length > 0) {
    out = out.replace(
      new RegExp(`(?<![\\w.\`])(${unambiguous.join('|')})(?![\\w.[])`, 'g'),
      (_m, name: string) => asCommand(name),
    );
  }
  if (bare.length > 0) {
    const alt = bare.join('|');
    out = out
      .replace(new RegExp(`\`(${alt})\``, 'g'), (_m, name: string) => asCommand(name))
      .replace(
        new RegExp(`\\b(Use|use|call|Call)\\s+(${alt})(?![\\w.[])`, 'g'),
        (_m, verb: string, name: string) => `${verb} ${asCommand(name)}`,
      )
      .replace(
        new RegExp(`\\b(${alt})(\\s+calls?\\b)`, 'g'),
        (_m, name: string, rest: string) => `${asCommand(name)}${rest}`,
      );
  }
  // A name that was already in backticks is now doubly quoted.
  return out.replace(/``+/g, '`');
}

export function augmentSystemPrompt(
  base: string | undefined,
  opts: {
    team?: boolean;
    toolInterface?: 'schemas' | 'bash-cli';
    /** Tool name → the command that runs it, for {@link retargetToolNames}. */
    commandFor?: ReadonlyMap<string, string>;
  } = {},
): string {
  let trimmed = stripToolCatalog((base ?? '').trim());
  /*
   * RETARGETING IS NOT ONLY FOR CLI MODE ANY MORE.
   *
   * A prompt that says "write the steps down with update_plan" while
   * `update_plan` is not in the advertised list is the exact failure this file
   * keeps meeting from the other direction: naming a tool the model cannot call
   * is worse than not naming it (llama-server's grammar will coerce the bid onto
   * whatever advertised name is nearest). Schemas mode now moves four tools into
   * the `coordinate` CLI group, so its prompt needs the same rewrite — for those
   * four names and nothing else.
   */
  if (opts.toolInterface === 'bash-cli') {
    // STRIP BEFORE RETARGETING. These are matched as literals, and retargeting
    // rewrites them first ("Use `read` …" → "Use `file read` …") so the literal
    // no longer matches and the false line survives into the prompt.
    for (const line of SCHEMA_ONLY_LINES) trimmed = trimmed.replace(line, '').trim();
    // A dropped guideline leaves a hole — "Guidelines:" followed by a blank
    // line, or a gap in the middle of the bullet list.
    trimmed = trimmed.replace(/\n{3,}/g, '\n\n').replace(/(:\n)\n+(?=- )/g, '$1');
  }
  if (opts.commandFor !== undefined) trimmed = retargetToolNames(trimmed, opts.commandFor);
  /*
   * THE CAPABILITY SECTION DESCRIBES THE SCHEMA INTERFACE, AND ONLY THAT ONE.
   *
   * It tells the model to reach tools by calling `capability`, names
   * `browser_navigate`, `present`, `spawn_subagent`, `talk_to_manager` and
   * `mac_snapshot`, and ends with "NEVER type a tool name at the shell —
   * `mac_snapshot` is a tool, not a command."
   *
   * In bash-CLI mode every one of those statements is false. `capability` is
   * not advertised (the active set is `['bash']`), none of those tool names are
   * callable, and typing a command at the shell is the ONLY thing the model can
   * do. The turn shipped both this and the CLI preamble, which says "These
   * commands are your abilities" — a flat contradiction, in the same prompt,
   * about the one thing the model needs to be sure of.
   *
   * That also means the 34/36 measured in tests/e2e/tool-cli-eval.mjs describes
   * a clean ~20-line prompt and NOT the shipped configuration. The verify
   * section still applies — how to check your work is interface-independent —
   * so only the capability half is dropped.
   */
  const section =
    opts.toolInterface === 'bash-cli' ? VERIFY_PROMPT : `${CAPABILITY_PROMPT}\n\n${VERIFY_PROMPT}`;
  if (trimmed.includes(CAPABILITY_PROMPT_MARKER)) return trimmed;
  if (trimmed.length === 0) return section;
  return `${trimmed}\n\n${section}`;
}
