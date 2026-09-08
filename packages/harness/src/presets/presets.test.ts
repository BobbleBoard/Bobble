import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities.js';
import { resolveBaseTools, TOOL_SEARCH_TOOL_NAME } from './presets.js';

/**
 * The WHOLE browser suite is advertised in every class, not just navigate +
 * snapshot. Measured cause: a run's tool array is snapshotted when the run
 * begins, so the other eight could never arrive mid-run — `capability` said
 * "browser is on … browser_click", the very next browser_click answered "Tool
 * browser_click not found", and the model looped on snapshot instead. Imported
 * from browser-use rather than spelled out, so a rename fails to compile here.
 */

// The full v0.1+ tool universe, as it would appear once every workstream lands.
// The browser_* names are the REAL ones registered by @pi-desktop/browser-use.
const ALL_TOOLS = [
  /* The always-active baseline has to be IN the universe or the contract test
     below cannot see it (a tool is only listed when it is registered). */
  'update_plan',
  'ask_user',
  'present',
  'spawn_subagent',
  'generate_image',
  'generate_video',
  'generate_speech',
  'generate_music',
  'generate_sfx',
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep',
  'bash',
  'web_search',
  'web_fetch',
  'python_run',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_read',
  'browser_wait',
  'browser_back',
  'browser_forward',
  'browser_key',
  'generate_image',
  'edit_image',
  'image_generate',
  'image_edit',
  'video_generate',
  'video_edit',
  'extract_frames',
  'probe',
  'video_locate',
  'image_segment',
  'image_detect',
  'image_ocr',
  'motion_graphics_render',
  'model_3d_generate',
  'model_3d_view',
  // The REAL macOS connector tool names registered by @pi-desktop/mac-connectors.
  'calendar_list_events',
  'calendar_create_event',
  'reminders_list',
  'reminders_create',
  'contacts_search',
  'mail_search',
  'mail_recent',
  'mail_read',
  'messages_recent',
  'messages_send',
  TOOL_SEARCH_TOOL_NAME,
];

describe('the base set — what every turn can reach', () => {
  /*
   * THE BASELINE IS A CEO'S BASELINE. the user: "it should always have the
   * commission tools… clean context ceo… no clutter with browser tools or
   * anything (it can have the basic tools + search though always) and then it
   * calls subagents to do browser use screenshots extraction… it commissions,
   * it's a CEO."
   *
   * MEASURED, runs 10-12: told to close its unknowns before briefing its
   * manager, the CEO delegated immediately every time — it had no web tool and
   * no subagent tool, because a keyword classifier decided both. There is no
   * classifier any more: there is one base set, and everything else arrives
   * through `capability`, which now actually lands inside the turn that asks
   * for it.
   */
  const BASELINE = [
    'read',
    'write',
    'edit',
    'bash',
    'update_plan',
    'ask_user',
    'present',
    'web_search',
    'web_fetch',
    'spawn_subagent',
    'capability',
  ];

  it('hands every turn the baseline — search, files, and a way to hand work out', () => {
    const tools = resolveBaseTools(ALL_TOOLS);
    for (const t of BASELINE) expect(tools, `missing ${t}`).toContain(t);
  });

  it('is the SAME set every time — a prefix that moves is a prefix never reused', () => {
    // The whole reason the per-task table went: tool schemas sit at the front of
    // the prompt, so a set that varies with the wording of a message throws the
    // KV cache away on every turn.
    const a = resolveBaseTools(ALL_TOOLS);
    const b = resolveBaseTools(ALL_TOOLS);
    expect(a).toEqual(b);
  });

  it('keeps the browser suite OUT — that is what `capability` is for', () => {
    const tools = resolveBaseTools(ALL_TOOLS);
    expect(tools).not.toContain('browser_snapshot');
    expect(tools).not.toContain('mac_snapshot');
  });

  it('lists no generation tool a build has not registered', () => {
    // The filter that keeps this honest: a desktop without gen-tools advertises
    // none of them rather than names the grammar can emit and nothing answers.
    const tools = resolveBaseTools(['read', 'write', 'bash']);
    expect(tools.some((t) => t.startsWith('generate_'))).toBe(false);
  });

  it('never lists a tool that is not registered', () => {
    const tools = resolveBaseTools(['read', 'bash']);
    expect(tools).toEqual(expect.arrayContaining(['read', 'bash']));
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('spawn_subagent');
  });
});

describe('capability and use travel together', () => {
  /*
   * MEASURED, from a shipped build: `capability` was advertised and `use` was
   * not, so the model was told it could reach mac_snapshot and then had no way
   * to call it. It typed `mac_snapshot` at the SHELL, which aborted. Naming a
   * tool the model cannot call is worse than not naming it.
   */
  it('advertises BOTH, in every preset that gets discovery', () => {
    const universe = ['read', 'write', 'edit', 'bash', 'capability', 'use'];
    const resolved = resolveBaseTools(universe);
    expect(resolved).toContain('capability');
    expect(resolved).toContain('use');
  });

  it('adds neither when neither is registered', () => {
    const resolved = resolveBaseTools(['read', 'bash']);
    expect(resolved).not.toContain('capability');
    expect(resolved).not.toContain('use');
  });
});

/*
 * `present` is the LAST act of any task that made something, so it must be
 * reachable from every class. It was registered and appeared in NO preset — the
 * same way `use` was missed — so the model never saw it, and llama-server's
 * grammar can only emit a name that is in the ADVERTISED list.
 */
describe('present is always reachable', () => {
  const withPresent = [
    'read',
    'write',
    'edit',
    'bash',
    'update_plan',
    'ask_user',
    'present',
    'capability',
    'use',
    'browser_navigate',
    'browser_snapshot',
  ];

  it('is advertised in the base set', () => {
    expect(resolveBaseTools(withPresent)).toContain('present');
  });

  it('is omitted when the build never registered it', () => {
    const without = withPresent.filter((t) => t !== 'present');
    expect(resolveBaseTools(without)).not.toContain('present');
  });
});

describe('the two workarounds that outlived their bug', () => {
  /*
   * Both were pinned to every prefix for the SAME reason and said so in their own
   * comments: `capability` could not deliver a toolset mid-turn, because pi's
   * agent loop snapshotted the tool array at turn start
   * (agent.js:273, `tools: this._state.tools.slice()`). That line is patched, and
   * a capability now lands inside the turn that asks for it — verified live at 14
   * tools on request 1 and 25 on request 3 of one turn.
   *
   * So they come off the prefix. These assert they stay off: re-adding either is
   * a real cost paid by every conversation that never asks for media or a page.
   */
  it('does not carry the generation tools', () => {
    const tools = resolveBaseTools(ALL_TOOLS);
    for (const t of ['generate_image', 'generate_video', 'generate_speech', 'generate_music']) {
      expect(tools, `${t} is back on every prefix`).not.toContain(t);
    }
  });

  it('does not carry the browser suite', () => {
    const tools = resolveBaseTools(ALL_TOOLS);
    for (const t of ['browser_navigate', 'browser_snapshot', 'browser_click']) {
      expect(tools, `${t} is back on every prefix`).not.toContain(t);
    }
  });

  it('still reaches both through a capability, which is the whole point', () => {
    const names = CAPABILITIES.flatMap((c) => c.tools);
    expect(names).toContain('generate_image');
    expect(names).toContain('browser_click');
  });
});
