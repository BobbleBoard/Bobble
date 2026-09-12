import { describe, expect, it } from 'vitest';
import { RIGOROUS_VERIFICATION } from '../verification-language.js';
import { specialistMeshPrompt as specialistPrompt } from './corp-mesh.js';
import {
  DELEGATION_ACTIVATED,
  MANAGER_PLANNING_TOOLS,
  NOT_READY_TO_DELEGATE,
  READY_TO_DELEGATE_DEFINITION,
  REQUEST_TEST_TOOLS_DEFINITION,
  TEST_TOOL_KIT_NAMES,
  testToolMenu,
  toolsForKits,
} from './manager-gates.js';

describe('the delegation gate', () => {
  it("returns the user's wording verbatim when called too early", () => {
    // Pinned because it is his sentence, and a well-meaning rewrite would change
    // what the manager is told to do at the one moment it is listening.
    expect(NOT_READY_TO_DELEGATE).toBe(
      'ensure you have mentally concrete plan before submitting, when ready to ' +
        'delegate, call the tool and delegate tasks',
    );
  });

  it('acknowledges with the phrase that says the gate opened', () => {
    expect(DELEGATION_ACTIVATED).toBe('delegation tools activated');
  });

  it('asks for the plan it claims to have, so "ready" is not a bare assertion', () => {
    expect(READY_TO_DELEGATE_DEFINITION.function.parameters.required).toContain('plan_summary');
  });

  it('tells the manager to brainstorm contracts to files and review them first', () => {
    const d = READY_TO_DELEGATE_DEFINITION.function.description;
    expect(d).toMatch(/brainstorm/i);
    expect(d).toMatch(/\.scratch/);
    expect(d).toMatch(/iterate/i);
  });
});

describe('the test-tool gate', () => {
  it('offers exactly the four kits, and says what each is for', () => {
    expect(TEST_TOOL_KIT_NAMES).toEqual(['browser', 'shell', 'computer_use', 'files']);
    const menu = testToolMenu();
    for (const k of TEST_TOOL_KIT_NAMES) expect(menu).toContain(k);
  });

  it('says it is for testing, after the engineers are done and the project has settled', () => {
    const d = REQUEST_TEST_TOOLS_DEFINITION.function.description;
    expect(d).toMatch(/only for\s+testing purposes/i);
    expect(d).toMatch(/after all engineers are finished/i);
    expect(d).toMatch(/settled/i);
  });

  it('resolves kits to tools, de-duplicated, and ignores names it does not know', () => {
    expect(toolsForKits(['shell'])).toEqual(['bash']);
    const both = toolsForKits(['files', 'shell', 'files']);
    expect(both).toContain('bash');
    expect(both).toContain('read');
    expect(new Set(both).size).toBe(both.length);
    expect(toolsForKits(['nonsense'])).toEqual([]);
  });

  it('grants read/write/edit through the file kit', () => {
    // the user, explicitly: "file manipulation should grant read write edit tools".
    const files = toolsForKits(['files']);
    for (const t of ['read', 'write', 'edit']) expect(files).toContain(t);
  });

  it('takes a REASON per kit, and never checks it', () => {
    /*
     * the user: "this is never checked by the harness, nothing is ever done with
     * it, but keeping it as an input implicitly combats the model asking for
     * everything every time for no reason." So the schema demands it and the
     * resolver ignores it — having to justify each kit IS the mechanism.
     */
    const item = REQUEST_TEST_TOOLS_DEFINITION.function.parameters.properties.kits.items;
    expect(item.required).toEqual(['kit', 'why']);
    // Resolution is unaffected by the reason, and bare names still work.
    expect(toolsForKits([{ kit: 'shell', why: 'run the exported binary' }])).toEqual(['bash']);
    expect(toolsForKits([{ kit: 'shell' }])).toEqual(['bash']);
    expect(toolsForKits(['shell'])).toEqual(['bash']);
  });
});

describe('the manager starts clean', () => {
  it('plans with no shell and no browser', () => {
    // The whole point of the gate: run 2's manager had bash from turn one and
    // used it to write project.godot itself, then to rm -rf the engineer's work.
    expect(MANAGER_PLANNING_TOOLS).not.toContain('bash');
    expect(MANAGER_PLANNING_TOOLS.some((t) => t.startsWith('browser_'))).toBe(false);
  });

  it('can still read, list and write its own notes', () => {
    expect(MANAGER_PLANNING_TOOLS).toContain('read');
    expect(MANAGER_PLANNING_TOOLS).toContain('ls');
    expect(MANAGER_PLANNING_TOOLS).toContain('write');
  });
});

describe('the verification standard reaches the prompts', () => {
  it('is one constant, so it cannot drift into a dozen paraphrases', () => {
    expect(RIGOROUS_VERIFICATION).toBe(
      'rigorous verification including non negotiably visually where applicable',
    );
  });
});

describe('the document specialist', () => {
  it('is on the roster and produces artifacts', async () => {
    const { MESH_SPECIALIST_KINDS, specialistToolsFor } = await import('./corp-mesh.js');
    expect(MESH_SPECIALIST_KINDS).toContain('document');
    const tools = specialistToolsFor('document');
    // bash is the load-bearing one: the RENDERERS write the file, not the model.
    expect(tools).toContain('bash');
    expect(tools).toContain('write');
    // It must be able to CAPTURE the product it is documenting.
    expect(tools.some((t) => t.startsWith('browser_'))).toBe(true);
  });

  it('is told to drive the pipeline and never hand-write the format', () => {
    // The whole reason this specialist exists. Two runs died on a model
    // inventing a file format from memory; the prompt has to close that door
    // explicitly, and name the tools that replace it. (It used to name
    // make_deck.py and friends — commands that, as written, did not exist.)
    const p = specialistPrompt('document');
    expect(p).toMatch(/NEVER HAND-WRITE THE FILE FORMAT/);
    expect(p).toMatch(/python-pptx/);
    expect(p).toMatch(/office_make/);
    expect(p).toMatch(/office_edit/);
    expect(p).toMatch(/office_inspect/);
  });

  it('must put the real product in a document about the product, and look at the result', () => {
    const p = specialistPrompt('document');
    expect(p).toMatch(/CAPTURE it/);
    expect(p).toMatch(/OPEN WHAT YOU MADE AND LOOK AT IT/);
  });
});
