import { describe, expect, it } from 'vitest';
import {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
  CLI_MECHANISM_SWAPS,
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

describe('no phantom tools in the prompt', () => {
  it('never mentions the removed tool_search', () => {
    expect(CAPABILITY_PROMPT).not.toMatch(/tool_search/);
  });

  it('points at capability instead', () => {
    expect(CAPABILITY_PROMPT).toMatch(/call `capability` first, then act/);
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
  it('tells bash-CLI mode how to REACH things, without the schema mechanism', () => {
    // The section used to be dropped whole, which cost the model the mapping
    // from "use <app>" to computer use. MEASURED on a real run with it absent:
    // the model shelled out to `open -a` and never touched the `mac` command
    // sitting on its PATH. Keep the WHAT, swap only the HOW.
    const cli = augmentSystemPrompt('base', { toolInterface: 'bash-cli' });
    expect(cli).not.toContain('NEVER type a tool name at the shell');
    expect(cli).not.toContain('call `capability`');
    expect(cli).toContain('already on your PATH');
    expect(cli).toContain('--help');
    // and it still carries the thing that matters: where to act
    expect(cli).toContain('native app vs browser');
  });

  it('never names `capability` in CLI mode, wrapped across a line or not', () => {
    /*
     * The guard above looked for "call `capability`" as one string. The prompt
     * wraps, so the browser paragraph's "call\n  `capability` with browser"
     * slipped past it and shipped — along with "TURN THE CAPABILITY ON …
     * activating it is your FIRST action", which told a model whose active set
     * is ['bash'] to begin by calling a tool that is not there.
     *
     * Match the NAME, not a phrase that happens to precede it.
     */
    const cli = augmentSystemPrompt('base', { toolInterface: 'bash-cli' });
    expect(cli).not.toMatch(/`capability`/);
    expect(cli).not.toMatch(/TURN THE CAPABILITY ON/);
    expect(cli).not.toMatch(/one activation, one plan/);
    expect(cli).toContain('already on your PATH');
  });

  it('applies every mechanism swap — a stale left-hand side is a silent no-op', () => {
    // Each swap is a literal `.replace`. Edit the prose it targets and the
    // replacement quietly stops happening, which is exactly how the sentences
    // above survived a prompt rewrite. Assert the source text is still findable.
    for (const [schemas] of CLI_MECHANISM_SWAPS) {
      expect(CAPABILITY_PROMPT, schemas.slice(0, 40)).toContain(schemas);
    }
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
