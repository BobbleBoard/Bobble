import { describe, expect, it } from 'vitest';
import {
  augmentSystemPrompt,
  BOBBLE_IDENTITY,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
  MANAGER_PROMPT_MARKER,
  retargetToolNames,
  stripToolCatalog,
  VERIFY_PROMPT,
} from './capability-prompt.js';

// pi's default base prompt shape (abbreviated): a full-registry tool catalog
// bounded by "Available tools:" … "In addition to the tools above…", then the
// rest of the base. The live prompt lists ~40 tools regardless of the active set.
const PI_BASE = `You are an expert coding assistant operating inside pi.

Available tools:
- read: Read file contents
- calendar_list_events: List the user's Calendar events in a date range
- messages_send: Send an iMessage
- mac_launch: Launch or focus a Mac app

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses`;

describe('stripToolCatalog', () => {
  it('removes the full "Available tools:" catalog block but keeps the rest', () => {
    const out = stripToolCatalog(PI_BASE);
    expect(out).not.toContain('Available tools:');
    expect(out).not.toContain('calendar_list_events');
    expect(out).not.toContain('messages_send');
    expect(out).not.toContain('In addition to the tools above');
    // The surrounding prose survives — this function only cuts the catalog;
    // the pi identity is a separate cut (see strip-pi.test.ts).
    expect(out).toContain('You are an expert coding assistant');
    expect(out).toContain('Guidelines:');
    expect(out).toContain('Be concise');
  });

  it('no-ops (returns the base) when there is no catalog to strip', () => {
    const plain = 'You are a coding agent.\n\nGuidelines:\n- Be concise';
    expect(stripToolCatalog(plain)).toBe(plain);
  });
});

describe('augmentSystemPrompt', () => {
  it('appends the capability section to a non-empty base', () => {
    const out = augmentSystemPrompt('You are a coding agent.');
    expect(out.startsWith('You are a coding agent.')).toBe(true);
    expect(out).toContain(CAPABILITY_PROMPT_MARKER);
  });

  it('strips pi’s full-registry tool catalog before appending (the bloat fix)', () => {
    const out = augmentSystemPrompt(PI_BASE);
    expect(out).not.toContain('calendar_list_events'); // catalog gone
    expect(out).not.toContain('Available tools:');
    // …and the pi identity is replaced on the way through (strip-pi.test.ts).
    expect(out).toContain(BOBBLE_IDENTITY);
    expect(out).toContain('Guidelines:'); // base prose kept
    expect(out).toContain(CAPABILITY_PROMPT_MARKER); // capability section added
  });

  it('returns the capability section alone for an empty/whitespace base', () => {
    expect(augmentSystemPrompt('')).toBe(`${CAPABILITY_PROMPT}\n\n${VERIFY_PROMPT}`);
    expect(augmentSystemPrompt('   \n  ')).toBe(`${CAPABILITY_PROMPT}\n\n${VERIFY_PROMPT}`);
    expect(augmentSystemPrompt(undefined)).toBe(`${CAPABILITY_PROMPT}\n\n${VERIFY_PROMPT}`);
  });

  it('is idempotent — a base already carrying the marker is not doubled', () => {
    const once = augmentSystemPrompt('base');
    const twice = augmentSystemPrompt(once);
    expect(twice).toBe(once);
    // The marker appears exactly once.
    expect(twice.split(CAPABILITY_PROMPT_MARKER).length - 1).toBe(1);
  });

  it('affirms the capabilities the model kept refusing (calendar/mail/messages) and points at capability', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    for (const cap of ['calendar', 'mail', 'messages', 'reminders', 'contacts']) {
      expect(p).toContain(cap);
    }
    expect(p).toContain('capability');
    // It must tell the model NOT to disclaim abilities it has.
    expect(p).toContain('never claim you "cannot access"');
  });

  it('tells the agent to BUILD/RUN/TEST its own artifacts, not punt to the user (item 4)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    // The artifact goes into the working dir via the agent's own tools…
    expect(p).toContain('written to the working directory with real content');
    // …the agent exercises it before reporting…
    expect(p).toContain('exercise it yourself');
    // …and never hands the doing-part back to the user (the exact punt language
    // the blind-test model produced: "save this as an HTML file… open it… test").
    expect(p).toContain('save this as');
    expect(p).toContain('double-click');
    expect(p).toMatch(/never end by telling the user to open/);
  });

  it('tells the agent to ACT rather than wander: write immediately, call the tool directly, act after a plan (item 8)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    // A write/create request must WRITE immediately, not read a pile of files.
    expect(p).toContain("act, don't wander");
    expect(p).toContain('write it immediately');
    expect(p).toMatch(/reading ten files without writing anything is wandering/);
    // A specific capability must call THAT tool, not read a file to get the date.
    expect(p).toContain('call that tool directly');
    expect(p).toContain('to find the date');
    expect(p).toContain('calendar');
    // After a plan, ACT — don't re-run `capability` / update_plan.
    expect(p).toContain('update_plan');
    expect(p).toContain('update_plan');
    expect(p).toMatch(/one activation, one plan, then do the work/);
  });

  it('keeps the harness/reviewer framing private so it cannot leak into the answer (item 5)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    expect(p).toContain('private scaffolding');
    // It names the exact leaks seen in the blind test as things NOT to say.
    expect(p).toContain('the reviewer flagged');
    expect(p).toContain('in a harness');
  });

  it('asks the agent not to reflexively spawn a subagent / open the browser for trivial tasks (item 6)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    expect(p).toMatch(/don't spawn a subagent, call the manager, or open the browser for a simple/);
  });

  /*
   * THE CEO IS TOLD IT HAS A MANAGER. It was not, for three measured runs: the
   * old team section was removed in f4c3f02 (rightly — it was said three times
   * and swapped in mid-run), the guidance moved to the tool description, and
   * `stripToolCatalog` then strips pi's prose catalog, so one JSON description
   * among seventeen was the only framing that reached the model. Result: the word
   * "manager" appears ZERO times in a 1.4MB max-effort transcript.
   *
   * the user: "?? why wouldn't it be" / "yes if the talk to tool isn't loaded, load
   * it." Said once, unconditionally, next to the line that tells it to work alone
   * — so the two rules are read together rather than one of them alone.
   */
  it('names the manager, and says it at every effort', () => {
    expect(CAPABILITY_PROMPT).toContain(MANAGER_PROMPT_MARKER);
    expect(CAPABILITY_PROMPT).toContain('talk_to_manager');
    // Identical prompt at every effort is the property f4c3f02 was protecting.
    expect(augmentSystemPrompt('Base.', { team: true })).toBe(augmentSystemPrompt('Base.'));
    expect(augmentSystemPrompt('Base.')).toContain(MANAGER_PROMPT_MARKER);
  });

  /* A model that is busy alone for an hour does not feel like it made a mistake. */
  it('says why building it alone is the expensive mistake', () => {
    expect(CAPABILITY_PROMPT).toMatch(/more expensive mistake/);
  });
});

describe('each capability carries its own guidance (the user)', () => {
  // "add tidbits to each capability in the system prompt, eg. utilize these tools
  // as the primary browser controls whenever you do something requiring a web
  // browser, utilize mac computer use if it is requested you do something in the
  // user's other browsers on their system ... bundle the calendar, email and
  // reminders stuff also."
  it('makes browser_navigate the DEFAULT way to visit a page', () => {
    // the user: "load browser navigate by default … bias it to use the built in
    // browser instead of bash to open safari when no specific is requested."
    expect(CAPABILITY_PROMPT).toContain('the DEFAULT way to visit any web');
    expect(CAPABILITY_PROMPT).toContain('never `open -a Safari`');
  });

  it('forbids re-navigating to a page it is already on', () => {
    // The loop the user hit: "constantly reopen the same link over and over".
    expect(CAPABILITY_PROMPT).toContain('NAVIGATING RETURNS THE PAGE');
    expect(CAPABILITY_PROMPT).toContain('NEVER navigate to a URL you are already on');
    // And it must name the tool that lets it look WITHOUT navigating — a browser
    // with no way to look is what forced the loop in the first place.
    expect(CAPABILITY_PROMPT).toContain('`browser_snapshot` is also always available');
  });

  it('says the rest of the browser suite is one capability call away', () => {
    expect(CAPABILITY_PROMPT).toContain('the whole suite arrives in your list');
  });

  it('sends computer use at the user’s OWN browsers, and only those', () => {
    expect(CAPABILITY_PROMPT).toContain('THEIR OWN\n  browsers');
    expect(CAPABILITY_PROMPT).toContain('Safari, Chrome, Arc');
  });

  it('tells it to act on an already-open tab rather than opening another', () => {
    // The bug the user hit: a blank second tab, snapshotted instead of his page.
    expect(CAPABILITY_PROMPT).toContain('act on THAT tab');
  });

  it('bundles calendar, mail, reminders, contacts and messages as ONE capability', () => {
    expect(CAPABILITY_PROMPT).toContain('CALENDAR, MAIL, REMINDERS, CONTACTS & MESSAGES');
    // …with the rule that matters: read/write via the connector, not the UI.
    expect(CAPABILITY_PROMPT).toContain('never drive the Calendar or Mail UI with computer use');
  });

  it('routes the user’s own Chrome through its DOM, not through pixels', () => {
    expect(CAPABILITY_PROMPT).toContain('GOOGLE CHROME');
    expect(CAPABILITY_PROMPT).toContain('chrome_snapshot');
    expect(CAPABILITY_PROMPT).toContain('Always prefer it over computer use for Chrome');
  });

  it('warns that opening from the shell lands in a real Mac app', () => {
    // The common case the user flagged: `open -a Safari` is computer-use territory.
    expect(CAPABILITY_PROMPT).toContain('hand the page to');
    expect(CAPABILITY_PROMPT).toContain('control it with computer use');
  });

  it('still says an AX-opaque app gives a screenshot to act on by coordinates', () => {
    expect(CAPABILITY_PROMPT).toContain('act by x,y coordinates');
  });

  /*
   * the user's named computer-use failure: "the model clicks Open in TextEdit, a
   * file dialog appears — that dialog is part of TextEdit, not Finder — and the
   * model must be able to see and drive it." Nothing in the prompt said so, and
   * a model that thinks a save panel belongs to another app goes looking for
   * Finder instead of clicking Save.
   */
  it('says the app’s own sheets and pickers are part of that app', () => {
    expect(CAPABILITY_PROMPT).toContain('save sheet, file picker');
    expect(CAPABILITY_PROMPT).toContain('belongs to the app that opened it');
  });

  it('says the user is watching, so the work stays in the background', () => {
    expect(CAPABILITY_PROMPT).toContain('watches it happen');
    expect(CAPABILITY_PROMPT).toContain('never take focus');
  });
});

/*
 * THE PROMPT MUST NOT NAME TOOLS THAT DO NOT EXIST.
 *
 * `tool_search` was removed and replaced by `capability`, but the prompt still
 * told the model to "tool_search first, then act". This is the same failure that
 * produced the browser_read confusion: prose naming an unadvertised tool. The
 * grammar pins the emitted name to the ADVERTISED list, so a bid for a tool the
 * prose invented lands on whichever real name is nearest — a plausible wrong
 * call rather than a clean failure.
 */
describe('no phantom tools in the prompt', () => {
  it('never mentions the removed tool_search', () => {
    expect(CAPABILITY_PROMPT).not.toMatch(/tool_search/);
  });

  it('points at capability instead', () => {
    expect(CAPABILITY_PROMPT).toMatch(/call `capability` first, then act/);
  });
});

describe('verification is required of any artifact', () => {
  it('does not limit the check to pages, scripts and tests', () => {
    // A Godot project was written (14 files) and never opened, because the old
    // wording only named HTML/script/test cases and nothing else mapped.
    expect(CAPABILITY_PROMPT).toMatch(/the cheapest thing that would REVEAL IT IS BROKEN/);
    expect(CAPABILITY_PROMPT).toMatch(/load the file with the tool that owns it/);
  });

  it('names the failure mode explicitly', () => {
    expect(CAPABILITY_PROMPT).toMatch(
      /Writing several files and reporting success without opening any of them/,
    );
  });
});

describe('capability activation is a first move, not a fallback', () => {
  it('tells the model to activate before concluding it cannot', () => {
    expect(CAPABILITY_PROMPT).toMatch(/TURN THE CAPABILITY ON BEFORE YOU DECIDE YOU CANNOT/);
    expect(CAPABILITY_PROMPT).toMatch(/your FIRST action, not a fallback/);
  });
});

describe('multi-step and destructive work leave a trail', () => {
  /* A chained task re-derived its position from the transcript every turn, and
   * `update_plan` was never called — the prompt said what to do AFTER writing a
   * plan but never when to write one. */
  it('asks for a plan when the work is a chain', () => {
    expect(CAPABILITY_PROMPT).toMatch(/WHEN THE WORK IS A CHAIN/);
    expect(CAPABILITY_PROMPT).toMatch(/mark each one off as it completes/);
  });

  it('does not demand a plan for a single action', () => {
    expect(CAPABILITY_PROMPT).toMatch(/a plan for a single action is noise/);
  });

  /* Nothing made a bulk filesystem change checkable after the fact, which is the
   * one class of mistake the user cannot undo by asking again. */
  it('requires a bulk or irreversible change to be stated and then checked', () => {
    expect(CAPABILITY_PROMPT).toMatch(/BEFORE ANYTHING BULK OR IRREVERSIBLE/);
    expect(CAPABILITY_PROMPT).toMatch(/"Done" is not an observation/);
  });
});

/*
 * THE TEAM SECTION.
 *
 * The delegation tool was in the model's `tools` array while the system prompt
 * never mentioned a manager, a team, or delegation at all — and stripToolCatalog
 * removes pi's prose catalog, where a tool's promptSnippet/promptGuidelines
 * would otherwise appear. So the only framing that reached the model was one
 * JSON description among sixteen. Measured: a max-effort platformer request with
 * the tool advertised produced 8 and then 78 solo turns and zero delegation.
 */

/*
 * THE PROMPT MUST NOT ARGUE WITH ITSELF.
 *
 * "Do the task — never hand it back" + "BUILD it and put it in place yourself"
 * (with `game` named among the artifacts) reads as a ban on delegating, and it
 * sits ABOVE the team section and is far more emphatic. Measured: three
 * consecutive max-effort runs where the CEO built a whole game alone with
 * talk_to_manager advertised — the last of them with the team section verifiably
 * in the prompt (12677 chars vs 11675). The two sections were telling it opposite
 * things and the older, louder one won.
 *
 * The clause was always about not handing work back to the USER. It now says so.
 */
describe('delegation is not forbidden by the do-the-task clause', () => {
  it('scopes "never hand it back" to the user', () => {
    expect(CAPABILITY_PROMPT).toContain('never hand it back TO THE USER');
  });

  it('no longer tells the model to build every artifact itself', () => {
    expect(CAPABILITY_PROMPT).not.toMatch(/BUILD it and put it in place yourself/);
  });
});

describe('the verification bar, now unconditional', () => {
  /*
   * REPLACES 'the delegation decision is made explicitly', which pinned
   * DECIDE_FIRST_PROMPT — the effort-gated block that also carried the team
   * framing. The delegation guidance moved to the tool description (the user's
   * wording); the verify half stayed, and stopped being conditional, because
   * checking your work before handing it over should not switch off at lower
   * effort — and a prompt that never changes is the point.
   */
  it('asks for a verify-as-the-user pass before submitting', () => {
    expect(VERIFY_PROMPT).toContain('think of yourself as the USER receiving it');
    expect(VERIFY_PROMPT).toContain('not optional');
  });

  it('is present at every effort', () => {
    expect(augmentSystemPrompt('Base.')).toContain(VERIFY_PROMPT);
    expect(augmentSystemPrompt('Base.', { team: true })).toContain(VERIFY_PROMPT);
  });

  it('no longer names an effort level, since it applies to all of them', () => {
    expect(VERIFY_PROMPT).not.toContain('HIGH/MAXIMUM');
  });
});

/*
 * Asked to screenshot a page and box its heading, the model spawned the IMAGE
 * specialist, which reasoned: "but I'm the IMAGE SPECIALIST - I should generate
 * images using my tools, not use computer use to drive a browser and then edit
 * the screenshot" — and then called generate_image (which was broken anyway) and
 * finally drew a filled rectangle on a blank canvas.
 *
 * Annotating an image that exists is not generation. Both prompts now say so.
 */
describe('pixel work is code, not generation', () => {
  it('separates inventing imagery from operating on an existing image', () => {
    expect(CAPABILITY_PROMPT).toMatch(/DETERMINISTIC PIXEL WORK IS CODE, NOT GENERATION/);
    expect(CAPABILITY_PROMPT).toMatch(/INVENTING something that did not exist/);
  });

  it('names the concrete operations that want code', () => {
    expect(CAPABILITY_PROMPT).toMatch(/cropping, resizing, compositing/);
  });

  it('says why a generation model is the wrong instrument for it', () => {
    expect(CAPABILITY_PROMPT).toMatch(/paints a fresh\s+picture of roughly the right idea/);
  });

  it('tells it to capture the thing first, and use the PATH', () => {
    expect(CAPABILITY_PROMPT).toMatch(/GO AND GET IT FIRST/);
    expect(CAPABILITY_PROMPT).toMatch(/never draw on a blank canvas/i);
  });
});

describe('the prompt must not contradict the interface it ships with', () => {
  /*
   * MEASURED by a repo-wide audit: in bash-CLI mode the shipped 12,934-char
   * system prompt told the model to reach tools with `capability` (not
   * advertised — the active set is ['bash']), named six tools it cannot call,
   * and ended with "NEVER type a tool name at the shell" — while the CLI
   * preamble in the same prompt said "These commands are your abilities."
   *
   * A model given both has been told the one thing it needs to be sure of, and
   * its opposite. It is the best available explanation for the measured
   * behaviour where it reimplemented a capability by hand instead of running
   * the command.
   */
  it('drops the capability section in bash-CLI mode', () => {
    const cli = augmentSystemPrompt('base', { toolInterface: 'bash-cli' });
    expect(cli).not.toContain('NEVER type a tool name at the shell');
    expect(cli).not.toContain('call `capability`');
  });

  it('keeps it in the schema mode it describes', () => {
    const schemas = augmentSystemPrompt('base', { toolInterface: 'schemas' });
    expect(schemas).toContain('NEVER type a tool name at the shell');
  });

  it('keeps the verify guidance in both — checking your work is interface-independent', () => {
    for (const mode of ['schemas', 'bash-cli'] as const) {
      const p = augmentSystemPrompt('base', { toolInterface: mode });
      expect(p.length).toBeGreaterThan('base'.length + 50);
    }
  });
});

describe('bash-CLI prompt is about commands, not tools', () => {
  const commandFor = new Map([
    ['update_plan', 'plan update'],
    ['spawn_subagent', 'team spawn'],
    ['edit', 'file edit'],
    ['read', 'file read'],
    ['write', 'file write'],
    ['browser_read', 'browser read'],
  ]);

  it('renames every tool the guidance names', () => {
    // pi renders usage guidance for REGISTERED tools, not advertised ones, so
    // the shipped CLI prompt told the model to call three tools it cannot call,
    // right above a command list saying those commands are its abilities.
    const base = [
      '- Use edit for precise changes (edits[].oldText must match exactly)',
      '- For any task with more than one step, call update_plan early.',
      '- Use spawn_subagent for independent sub-tasks.',
    ].join('\n');
    const out = augmentSystemPrompt(base, { toolInterface: 'bash-cli', commandFor });
    expect(out).toContain('`file edit`');
    expect(out).toContain('`plan update`');
    expect(out).toContain('`team spawn`');
    expect(out).not.toMatch(/\bspawn_subagent\b/);
    expect(out).not.toMatch(/\bupdate_plan\b/);
  });

  it('leaves parameter names alone — edits[] is still edits[]', () => {
    const out = augmentSystemPrompt('- edits[].oldText must match exactly', {
      toolInterface: 'bash-cli',
      commandFor,
    });
    expect(out).toContain('edits[].oldText');
  });

  it('does not rename a longer tool through a shorter entry', () => {
    const out = retargetToolNames('use browser_read on the page', commandFor);
    expect(out).toBe('use `browser read` on the page');
  });

  it('drops the two lines that are false once bash is the interface', () => {
    const base = [
      '- Prefer grep/find/ls tools over bash for file exploration (faster)',
      '- Use read to examine files instead of cat or sed.',
      '- Be concise in your responses',
    ].join('\n');
    const out = augmentSystemPrompt(base, { toolInterface: 'bash-cli', commandFor });
    expect(out).not.toContain('Prefer grep/find/ls');
    expect(out).not.toContain('instead of cat or sed');
    expect(out).toContain('Be concise');
  });

  it('leaves the schema-mode prompt untouched', () => {
    const base = '- Use spawn_subagent for independent sub-tasks.';
    expect(augmentSystemPrompt(base, { toolInterface: 'schemas', commandFor })).toContain(
      'spawn_subagent',
    );
  });
});

describe('answering "what can you do?"', () => {
  /*
   * The blind tester asked the model what it could do and was told `ask_user`,
   * `update_plan`, `spawn_subagent`, `talk_to_manager`: "That's internal
   * machinery. It's like asking a colleague what they do and being told 'I can
   * hold meetings and delegate.'"
   *
   * The opening screen now answers this question itself (starters.ts), which is
   * the better fix because the app cannot be wrong about itself. This is the
   * other half: when the question is TYPED, the model has to answer it in the
   * user's vocabulary rather than its own.
   */
  it('tells the model to answer in things a person might want', () => {
    expect(CAPABILITY_PROMPT).toContain('ASKED WHAT YOU CAN DO');
    expect(CAPABILITY_PROMPT).toMatch(/never in tool names/i);
  });

  it('names the four that are machinery, so they cannot be offered as features', () => {
    const line = CAPABILITY_PROMPT.split('\n').find((l) => l.includes('ASKED WHAT YOU CAN DO'));
    expect(line).toBeDefined();
    for (const t of ['ask_user', 'update_plan', 'spawn_subagent', 'talk_to_manager']) {
      expect(line).toContain(t);
    }
  });

  it('asks for concrete examples rather than a list', () => {
    const line = CAPABILITY_PROMPT.split('\n').find((l) => l.includes('ASKED WHAT YOU CAN DO'));
    expect(line).toMatch(/concrete things they could ask for/);
  });

  it('says the local thing, because that is the answer nothing else gives', () => {
    const line = CAPABILITY_PROMPT.split('\n').find((l) => l.includes('ASKED WHAT YOU CAN DO'));
    expect(line).toMatch(/nothing leaves it/);
  });
});
