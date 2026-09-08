/**
 * Capabilities replace tool_search. the user: "remove tool search entirely, and
 * instead replace with a 'capability' tool … the tools can be computer use,
 * mail, calendar, browser etc.", and separately "the tool search isn't great and
 * is a source of much looping right now."
 *
 * A capability is a FIXED named set turned on in one call, so the same request
 * always yields the same tools — the property a scored free-text query lacked.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  type Capability,
  capabilityActivated,
  capabilityMenu,
  findCapability,
} from './capabilities';

describe('asking for a capability by name', () => {
  it('finds one however the model spells it', () => {
    for (const spelling of ['computer-use', 'computer use', 'Computer_Use', ' COMPUTER-USE ']) {
      expect(findCapability(spelling)?.name).toBe('computer-use');
    }
  });

  it('takes a near miss rather than refusing — "mail" plainly means personal', () => {
    expect(findCapability('personal')?.name).toBe('personal');
    expect(findCapability('browser')?.name).toBe('browser');
  });

  it('returns nothing for something that is not a capability', () => {
    expect(findCapability('teleportation')).toBeUndefined();
  });
});

describe('the groups themselves', () => {
  it('bundles calendar, mail, reminders, contacts and messages as ONE thing', () => {
    // the user: "bundle the calendar, email and reminders stuff also."
    const personal = findCapability('personal');
    expect(personal?.summary).toContain('Calendar');
    expect(personal?.summary).toContain('Mail');
    expect(personal?.summary).toContain('Reminders');
    expect((personal?.tools.length ?? 0) > 1).toBe(true);
  });

  it('carries the WHEN, not just the what — each has guidance', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.guidance.length).toBeGreaterThan(40);
      expect(cap.summary.length).toBeGreaterThan(10);
      expect(cap.tools.length).toBeGreaterThan(0);
    }
  });

  it('sends Chrome down the DOM path inside computer-use', () => {
    expect(findCapability('computer-use')?.guidance).toContain('chrome_*');
  });

  /*
   * In bash-CLI mode this summary is ALL the model gets about the group — the
   * capability section that spells it out is stripped there. So "an app's own
   * dialogs are part of that app", which is the whole of the user's TextEdit
   * save-panel complaint, has to survive into the one line.
   */
  it('says dialogs and file pickers are part of the app, in the summary itself', () => {
    const cu = findCapability('computer-use');
    expect(cu?.summary).toContain('dialogs, sheets and file pickers');
    expect(cu?.guidance).toContain('part of the app that opened it');
  });
});

describe('what the model is told', () => {
  it('lists every capability when asked bare', () => {
    const menu = capabilityMenu();
    for (const cap of CAPABILITIES) expect(menu).toContain(cap.name);
  });

  it('names the tools it just gained, and how to use them', () => {
    const cap = findCapability('browser');
    if (cap === undefined) throw new Error('browser capability missing');
    const text = capabilityActivated(cap, [...cap.tools]);
    expect(text).toContain('is on');
    expect(text).toContain(cap.tools[0] ?? '');
    expect(text).toContain('PRIMARY web control');
  });

  /*
   * IT MUST NOT SAY THE TOOLS ARE HERE NOW — because they are not.
   *
   * pi snapshots a run's tool array when the run starts (pi-agent-core
   * agent.js:273), so `setActiveTools` lands on the NEXT run: "Changes take
   * effect on the next agent turn." MEASURED against the running server — this
   * function answered "browser is on. You now have: … browser_click …", and the
   * model's very next `browser_click` came back "Tool browser_click not found",
   * twice, while the advertised array never moved off tools[17] in 20 requests.
   *
   * The old wording was the whole lie. A model that believes it retries; a model
   * told the truth spends the rest of the turn on what it can actually do.
   */
  it('says the tools arrive NEXT reply, never that they are callable now', () => {
    const cap = findCapability('browser');
    if (cap === undefined) throw new Error('browser capability missing');
    const text = capabilityActivated(cap, [...cap.tools]);
    expect(text).toMatch(/NEXT reply/);
    expect(text).toMatch(/NOT callable in this reply/i);
    expect(text).not.toMatch(/You now have/);
  });

  it('the menu does not promise immediate availability either', () => {
    expect(capabilityMenu()).not.toMatch(/immediately/i);
    expect(capabilityMenu()).toMatch(/NEXT reply/);
  });

  it('says so honestly when a capability is not in this build', () => {
    const cap = findCapability('generation');
    if (cap === undefined) throw new Error('generation capability missing');
    // None of its tools registered — pretending would have the model call nothing.
    expect(capabilityActivated(cap, ['read', 'bash'])).toContain('not available in this build');
  });

  it('only ever claims the tools that actually exist', () => {
    const cap = findCapability('personal');
    if (cap === undefined) throw new Error('personal capability missing');
    const only = cap.tools[0] ?? '';
    const text = capabilityActivated(cap, [only]);
    expect(text).toContain(only);
    for (const missing of cap.tools.slice(1)) expect(text).not.toContain(missing);
  });
});

/*
 * IN CLI MODE THERE IS NOTHING TO WAIT FOR.
 *
 * the user: "tool being appended mid conversation is fine, but not during cli mode,
 * because during cli mode a tool happening mid conversation is just a little
 * tidbit at the end of the message." The advertised set stays `['bash']` and
 * every tool is already a command on PATH, so the schemas wording — "not
 * callable in this reply" — is false there, and costs a turn: the model stops
 * and announces what it is about to do instead of doing it.
 */
describe('capabilityActivated in CLI mode', () => {
  const cap = CAPABILITIES.find((c) => c.name === 'browser') as Capability;
  const available = [...cap.tools];

  it('says the commands are usable NOW', () => {
    const text = capabilityActivated(cap, available, 'browser');
    expect(text).toContain('available NOW');
    expect(text).toContain('`browser --help`');
    expect(text).toContain('in THIS reply');
  });

  it('never tells the model to wait a turn', () => {
    const text = capabilityActivated(cap, available, 'browser');
    expect(text).not.toContain('NEXT reply');
    expect(text).not.toContain('NOT callable');
  });

  /* The schemas wording is unchanged — there the wait is real, because
   * activation genuinely changes the advertised tool array. */
  it('keeps the schemas wording when there is no command', () => {
    const text = capabilityActivated(cap, available);
    expect(text).toContain('NEXT reply');
    expect(text).toContain('NOT callable');
  });

  it('still refuses to pretend about a capability this build does not have', () => {
    for (const cli of ['browser', undefined]) {
      expect(capabilityActivated(cap, [], cli)).toContain('not available in this build');
    }
  });

  it('carries the guidance either way', () => {
    expect(capabilityActivated(cap, available, 'browser')).toContain(cap.guidance);
    expect(capabilityActivated(cap, available)).toContain(cap.guidance);
  });
});
