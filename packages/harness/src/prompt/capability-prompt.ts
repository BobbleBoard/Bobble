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
import { attributeGuidelines, type GuidelineSource } from './guidelines.js';

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
/**
 * HOW TO REACH A CAPABILITY — the one paragraph that differs by interface.
 *
 * Everything else in this section is about WHAT the app can do and WHEN to
 * reach for it, which is true either way. Only this paragraph describes the
 * mechanism, and it used to be the reason the whole section was dropped in
 * bash-CLI mode — where every sentence of it is false.
 *
 * Dropping it cost far more than it saved. MEASURED on a real CLI-mode run:
 * with no capability section at all, the model asked to "open TextEdit and type
 * X" never once reached for the `mac` command that was sitting on its PATH. It
 * shelled out to `open -a "TextEdit"` — which takes the user's screen — and
 * then wrote a temp file. It had the tools and no idea they were the answer.
 */
export const CAPABILITY_REACH_SCHEMAS =
  'Only a few tools are in your list at any moment. To reach the rest, call `capability` — with no argument to see what is on offer, or with a name (browser, computer-use, personal, web-research, generation, office, connectors) to turn that group on. Its tools then appear in your list and you call them normally. A tool you cannot see is one `capability` call away, never a capability you lack. NEVER type a tool name at the shell — `mac_snapshot` is a tool, not a command.';

export const CAPABILITY_REACH_CLI =
  "Every one of these is a COMMAND already on your PATH — nothing to turn on, nothing to wait for. Run `<command> --help` the first time you use one and it will tell you its verbs and flags. Reach for them rather than improvising with general shell tools: `open -a` hands an app to the user's foreground instead of to you, and a file written and opened is not the same as having used the app.";

/**
 * The sentences that describe the MECHANISM rather than the ability.
 *
 * The reach paragraph is not the only place the section says "call
 * `capability`", and in CLI mode there is no such tool. The list shrank with the
 * prompt itself — most of the prose these targeted is gone — but the mechanism
 * is still named inside the rules, so the swap stays.
 */
export const CLI_MECHANISM_SWAPS: ReadonlyArray<readonly [string, string]> = [
  [
    'if unsure, call `capability` first, then act',
    'if unsure, run `<command> --help` first, then act',
  ],
];

export const CAPABILITY_PROMPT = `${CAPABILITY_PROMPT_MARKER}

${CAPABILITY_REACH_SCHEMAS}

Choosing where to act — native app vs browser:
- To OPEN something for the user — an app, a document, a place on a map, a note, a setting — that is the NATIVE macOS app. "Open my mail", "open maps to …", "open notes" mean the Mac app, not a web page.
- Anything that is genuinely a web task goes in the built-in browser (the browser tools; the user watches it in the Activity tab), not in one of the user's own browsers. The user's OWN Chrome (the chrome tools) and computer use on a browser window are for when they NAME it — "in Chrome", "in my browser", "the tab I have open" — never just because the task is on the web.

Rules:
- You CAN reach the user's calendar, mail, messages, contacts, reminders, files, and the web through your tools. Never claim you "cannot access" or "don't have the capability" for anything above — if unsure, call \`capability\` first, then act.
- Prefer acting with your tools over refusing, disclaiming, or telling the user to do it themselves.
- WHEN YOU BUILD SOMETHING, HAVE IT TESTED — spawn_subagent takes specialist:"tester", which works out how to DRIVE what you built, runs it as a user would, and comes back with the failures and screenshots. "I fixed it" is a claim; "the tester ran it and it passed" is a result.
- YOU HAVE A MANAGER AND A TEAM for a big build: talk_to_manager hands the work to a manager who splits it across their engineers and delivers it back for you to review. Ask yourself at the START of a large request whether to call them in — building a large project alone is the more expensive mistake, and the easier one to make.`;

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
/**
 * Cut the parts of pi's base prompt that are about PI, not about Bobble.
 *
 * the user: "there's a bunch about pi, about being a coding assistant all that can
 * go." He is right on both counts and they cost different things.
 *
 * The identity line ("You are an expert coding assistant operating inside pi, a
 * coding agent harness") tells the model it is a coding tool, and it answers
 * accordingly — a person asking it to tidy their Downloads folder is talking to
 * something that has been told its job is editing code.
 *
 * The "Pi documentation" block is worse value still: eight lines of absolute
 * paths into the app bundle, describing how to answer questions about pi's own
 * SDK, extensions, themes and TUI. Nobody using Bobble asks those questions, and
 * it is paid for in every prefill of every turn.
 *
 * Matched on their own opening words rather than by index, so a base that no
 * longer contains them is returned untouched. Pure.
 */
export function stripPiIdentity(base: string): string {
  let out = base;
  /* The first paragraph, up to the blank line before "Guidelines:". */
  /*
   * REMOVED, not replaced.
   *
   * It used to swap pi's "you are an expert coding assistant operating inside
   * pi" for a Bobble sentence of the same shape. the user, cutting the prompt down:
   * "strip out the part about 'describing pi' and 'you are pi' just keep the
   * tool descriptions and simple guidelines they give." An identity paragraph is
   * not guidance — the model's behaviour comes from the rules and the commands,
   * and this was three lines of prefill on every turn saying who it is.
   */
  out = out.replace(
    /^You are an expert coding assistant operating inside pi[^\n]*\n(?:[^\n]*\n)*?\n/,
    '',
  );
  /* The pi-docs block: its heading through to the last of its bullets. */
  const docsStart = out.indexOf('Pi documentation (read only when the user asks about pi itself');
  if (docsStart >= 0) {
    const rest = out.slice(docsStart);
    const blank = rest.search(/\n(?!- )(?! {2})\S/);
    out = blank >= 0 ? out.slice(0, docsStart) + rest.slice(blank + 1) : out.slice(0, docsStart);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

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
/**
 * WHERE A SHELL COMMAND STARTS. the user (2026-09-13): "make it very clear to the
 * model if their terminal is in their working directory always or they have
 * to type cd <working> && <command> on every command — it seems they sometimes
 * do that a lot." The fact (index.ts, the bash spawnHook): every command runs
 * in a FRESH shell whose cwd is the working folder. So `cd <folder> &&` is
 * never needed to get there, and a `cd` never carries to the next command.
 */
export const SHELL_CWD_TRUTH =
  'Every shell command already starts in that folder, in a fresh shell: run `<command>` ' +
  'as it is, never `cd <that folder> && <command>`. A `cd` lasts only for the one command ' +
  'it is in.';

/**
 * The same capability section, told in commands.
 *
 * The section's value is the mapping from what the user asks to what this app
 * can do — "use <app>" means computer use, a web page means the built-in
 * browser — and that mapping does not change with the interface. Only the tool
 * names and the reach paragraph do, and both are mechanical to swap.
 */
export function capabilityPromptForCli(commandFor?: ReadonlyMap<string, string>): string {
  let body = CAPABILITY_PROMPT.replace(CAPABILITY_REACH_SCHEMAS, CAPABILITY_REACH_CLI)
    // The same mechanism, named once more inside the guidelines. There is no
    // `capability` call to make here: the way to find out is to ask a command.
    .replace(
      'if unsure, call `capability` first, then act',
      'if unsure, run `<command> --help` first, then act',
    );
  for (const [schemas, cli] of CLI_MECHANISM_SWAPS) body = body.replace(schemas, cli);
  return commandFor === undefined ? body : retargetToolNames(body, commandFor);
}

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
    /*
     * The backtick is NOT in the lookbehind. It used to be, which meant a name
     * already written as `update_plan` was skipped — and that is how tool names
     * are written in prose almost everywhere, so the shipped CLI prompt kept
     * naming tools the model cannot call. Double backticks are collapsed at the
     * end, which is what the exclusion was really guarding against.
     */
    out = out.replace(
      new RegExp(`(?<![\\w.])(${unambiguous.join('|')})(?![\\w.[])`, 'g'),
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
    /**
     * Whose guideline is whose, and which tools the model has — so pi's
     * "Guidelines:" bullets come out named and pruned (see ./guidelines.ts).
     * Absent ⇒ the block is left as pi wrote it.
     */
    guidelines?: { sources: readonly GuidelineSource[]; active: ReadonlySet<string> };
    /**
     * Where the tools actually work. pi prints the directory it was STARTED
     * in; the harness roots every tool at the chat's folder, which for a
     * projectless chat is decided on its first message. When they differ the
     * model must be told the folder, not the launch dir.
     */
    workingDirectory?: string;
  } = {},
): string {
  let trimmed = stripPiIdentity(stripToolCatalog((base ?? '').trim()));
  if (opts.workingDirectory !== undefined && opts.workingDirectory.length > 0) {
    trimmed = trimmed.replace(
      /^Current working directory: .*$/m,
      `Current working directory: ${opts.workingDirectory}\n${SHELL_CWD_TRUTH}`,
    );
  }
  if (opts.guidelines !== undefined) {
    const cmd = opts.commandFor;
    trimmed = attributeGuidelines(trimmed, opts.guidelines.sources, {
      active: opts.guidelines.active,
      ...(cmd !== undefined ? { nameFor: (t: string): string => `\`${cmd.get(t) ?? t}\`` } : {}),
    });
  }
  if (opts.toolInterface === 'bash-cli') {
    // STRIP BEFORE RETARGETING. These are matched as literals, and retargeting
    // rewrites them first ("Use `read` …" → "Use `file read` …") so the literal
    // no longer matches and the false line survives into the prompt.
    for (const line of SCHEMA_ONLY_LINES) trimmed = trimmed.replace(line, '').trim();
    // A dropped guideline leaves a hole — "Guidelines:" followed by a blank
    // line, or a gap in the middle of the bullet list.
    if (opts.commandFor !== undefined) trimmed = retargetToolNames(trimmed, opts.commandFor);
    trimmed = trimmed.replace(/\n{3,}/g, '\n\n').replace(/(:\n)\n+(?=- )/g, '$1');
  }
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
    opts.toolInterface === 'bash-cli'
      ? `${capabilityPromptForCli(opts.commandFor)}\n\n${VERIFY_PROMPT}`
      : `${CAPABILITY_PROMPT}\n\n${VERIFY_PROMPT}`;
  if (trimmed.includes(CAPABILITY_PROMPT_MARKER)) return trimmed;
  if (trimmed.length === 0) return section;
  return `${trimmed}\n\n${section}`;
}
