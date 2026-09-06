import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import { describe, expect, it } from 'vitest';
import { TASK_CLASSES, type TaskClass } from '../classify/classify.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../subagent/types.js';
import {
  isToolSearchOnly,
  PRESET_TOOLS,
  resolvePresetTools,
  TOOL_SEARCH_TOOL_NAME,
} from './presets.js';

/**
 * The WHOLE browser suite is advertised in every class, not just navigate +
 * snapshot. Measured cause: a run's tool array is snapshotted when the run
 * begins, so the other eight could never arrive mid-run — `capability` said
 * "browser is on … browser_click", the very next browser_click answered "Tool
 * browser_click not found", and the model looped on snapshot instead. Imported
 * from browser-use rather than spelled out, so a rename fails to compile here.
 */
const BROWSER_SUITE = BROWSER_TOOL_NAMES;

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

describe('PRESET_TOOLS', () => {
  it('has an entry for every task class', () => {
    for (const cls of TASK_CLASSES) {
      expect(PRESET_TOOLS[cls]).toBeDefined();
    }
  });
});

describe('resolvePresetTools — what every turn can reach', () => {
  /*
   * THE BASELINE IS A CEO'S BASELINE. the user: "it should always have the
   * commission tools… clean context ceo… no clutter with browser tools or
   * anything (it can have the basic tools + search though always) and then it
   * calls subagents to do browser use screenshots extraction… it commissions,
   * it's a CEO."
   *
   * MEASURED, runs 10-12: told to close its unknowns before briefing its
   * manager, the CEO delegated immediately every time — it had no web tool and
   * no subagent tool, because a keyword classifier decided both. These assert
   * the CONTRACT (what is reachable) rather than an exact array, so adding a
   * tool to a class stops being a test edit.
   */
  const BASELINE = [
    'read',
    'write',
    'edit',
    'bash',
    'present',
    'web_search',
    'web_fetch',
    'capability',
  ];

  /*
   * THE FOUR THAT LEFT THE PREFIX. `update_plan`, `ask_user`, `spawn_subagent`
   * and `talk_to_manager` moved to the `coordinate` CLI group — 8,516 characters
   * of every request, MEASURED, for tools most turns never reach.
   */
  const COORDINATION = ['update_plan', 'ask_user', SPAWN_SUBAGENT_TOOL_NAME];

  it('gives EVERY class the baseline — search and a way to hand work out', () => {
    for (const cls of Object.keys(PRESET_TOOLS) as TaskClass[]) {
      const tools = resolvePresetTools(cls, ALL_TOOLS);
      for (const t of BASELINE) {
        expect(tools, `${cls} is missing ${t}`).toContain(t);
      }
    }
  });

  it('advertises the WHOLE browser suite to a class that gets it', () => {
    /*
     * THE GUARD THIS FILE ALREADY DESCRIBED AND NO LONGER ASSERTED.
     *
     * `BROWSER_SUITE` sat here with its measured-cause comment and not one
     * expectation reading it, so the invariant it documents — all ten names,
     * not navigate + snapshot — was being carried by a comment. A run's tool
     * array is snapshotted when the run begins, so a missing name cannot arrive
     * later: `capability` said "browser is on … browser_click" and the very
     * next browser_click answered "Tool browser_click not found".
     */
    const tools = resolvePresetTools('browser-use', ALL_TOOLS);
    for (const name of BROWSER_SUITE) {
      expect(tools, `browser-use was missing ${name}`).toContain(name);
    }
  });

  it('lets EVERY class hand work out — and charges none of them for it', () => {
    /*
     * Handing work out is baseline, not a privilege of certain task classes.
     * It was gated to `SUBAGENT_PRESET_CLASSES` once, which made "can this model
     * commission anything" depend on how a keyword classifier read the prompt —
     * and that is how a CEO told to research and commission specialists ended up
     * able to do neither (MEASURED, runs 10-12).
     *
     * The fix was to put it in every preset. The better fix is to put it in NO
     * preset: a CLI group is not class-dependent at all, so "every class can
     * commission" is now true by construction rather than by a list that has to
     * be kept right — and no class pays 2,217 characters for the privilege.
     *
     * What this test guards is that the gate cannot come back in either
     * direction: not as a class list, and not as a schema on every turn.
     */
    for (const cls of TASK_CLASSES) {
      const tools = resolvePresetTools(cls, ALL_TOOLS);
      for (const t of COORDINATION) {
        expect(tools, `${cls} is still paying for ${t}`).not.toContain(t);
      }
    }
  });

  it('keeps the BROWSER suite out unless the class is about it', () => {
    for (const cls of ['coding', 'simple-QA', 'other', 'file-ops'] as TaskClass[]) {
      const tools = resolvePresetTools(cls, ALL_TOOLS);
      expect(tools, `${cls} dragged in the browser suite`).not.toContain('browser_snapshot');
    }
  });

  it('DOES carry the generation tools on every turn', () => {
    /*
     * THIS EXPECTATION IS A REVERSAL, and deliberately so. It used to assert the
     * opposite — "a CEO commissions this work; it does not carry the tools
     * around" — which was coherent while generation was something you delegated.
     *
     * the user: "from the chat interface, these backends should be connected. I
     * should be able to go to a new chat and ask for any of these types of media
     * or files, all are delivered." That is the browser argument in reverse: a
     * suite you occasionally drive stays behind a class, and a verb you might
     * reach for in ANY conversation has to be in hand.
     *
     * They cannot arrive another way. The per-turn class is hardcoded to
     * 'coding', so no generation preset is ever selected, and `use` cannot
     * dispatch another extension's tool.
     */
    for (const cls of ['coding', 'simple-QA', 'other', 'file-ops'] as TaskClass[]) {
      const tools = resolvePresetTools(cls, ALL_TOOLS);
      for (const t of ['generate_image', 'generate_video', 'generate_speech']) {
        expect(tools, `${cls} could not reach ${t}`).toContain(t);
      }
    }
  });

  it('lists no generation tool a build has not registered', () => {
    // The filter that keeps this honest: a desktop without gen-tools advertises
    // none of them rather than five names the grammar can emit and nothing can
    // answer.
    const tools = resolvePresetTools('coding', ['read', 'write', 'bash']);
    expect(tools.some((t) => t.startsWith('generate_'))).toBe(false);
  });

  it('still front-loads the browser suite for a turn whose job IS a page', () => {
    const tools = resolvePresetTools('browser-use', ALL_TOOLS);
    expect(tools).toContain('browser_navigate');
    expect(tools).toContain('browser_snapshot');
    /* Round-10 #9: snapshot must be present and early — the model has to SEE
       the page before it can click it. */
    expect(tools.indexOf('browser_snapshot')).toBeLessThan(tools.indexOf('browser_click'));
  });

  it('front-loads each class its own domain tools', () => {
    expect(resolvePresetTools('coding', ALL_TOOLS)).toContain('python_run');
    expect(resolvePresetTools('2d-art', ALL_TOOLS)).toContain('generate_image');
    expect(resolvePresetTools('perception', ALL_TOOLS)).toContain('image_segment');
    expect(resolvePresetTools('video-edit', ALL_TOOLS)).toContain('extract_frames');
    expect(resolvePresetTools('connectors', ALL_TOOLS).length).toBeGreaterThan(BASELINE.length);
  });

  it('never lists a tool that is not registered', () => {
    const tools = resolvePresetTools('coding', ['read', 'bash']);
    expect(tools).toEqual(expect.arrayContaining(['read', 'bash']));
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('spawn_subagent');
  });
});

describe('resolvePresetTools — graceful degradation (v0.1 tool set)', () => {
  // In v0.1 the generation/browser tools do not exist yet.
  const V01_TOOLS = [
    'read',
    'write',
    'edit',
    'ls',
    'find',
    'grep',
    'bash',
    'python_run',
    TOOL_SEARCH_TOOL_NAME,
  ];

  it('a category whose domain tools are absent falls back to file tools + capability', () => {
    for (const cls of [
      'motion-graphics',
      'advanced-video',
      '3d',
      '2d-art',
      'browser-use',
    ] as const) {
      // No domain tools registered → the class keeps only the always-active file
      // tools + capability. It is NO LONGER bare tool-search-only: the user made
      // read/write/edit/bash globally available so even a stripped class can act.
      const tools = resolvePresetTools(cls, V01_TOOLS);
      expect(tools).toEqual(['capability', 'read', 'write', 'edit', 'bash']);
      expect(isToolSearchOnly(tools)).toBe(false);
    }
  });

  it('never returns a tool that is not registered', () => {
    const tools = resolvePresetTools('coding', V01_TOOLS);
    for (const t of tools) expect(V01_TOOLS).toContain(t);
  });

  it('omits capability when it is not registered', () => {
    const tools = resolvePresetTools('coding', ['read', 'bash']);
    expect(tools).toEqual(['read', 'bash']);
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
    const resolved = resolvePresetTools('coding', universe);
    expect(resolved).toContain('capability');
    expect(resolved).toContain('use');
  });

  it('adds neither when neither is registered', () => {
    const resolved = resolvePresetTools('coding', ['read', 'bash']);
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

  it('is advertised in every task class', () => {
    for (const cls of TASK_CLASSES) {
      expect(resolvePresetTools(cls, withPresent), cls).toContain('present');
    }
  });

  it('is omitted when the build never registered it', () => {
    const without = withPresent.filter((t) => t !== 'present');
    expect(resolvePresetTools('coding', without)).not.toContain('present');
  });
});
