/**
 * The tool's contract with the app: what it writes, and what it tells the model
 * it wrote. Both matter — the model relays the second to the user, so a summary
 * that omits the defaults it filled in is how someone finds out at 9am.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
vi.spyOn(os, 'homedir').mockReturnValue(HOME);

const STORE = path.join(HOME, '.pi', 'desktop', 'scheduled-tasks.json');

// Imported AFTER the homedir mock so the module's STORE_PATH picks it up.
const { registerScheduledTaskTool } = await import('./schedule-tool.js');

interface Registered {
  name: string;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[]; isError: boolean }>;
}

function register(): Registered {
  let tool: Registered | undefined;
  registerScheduledTaskTool({
    registerTool: (t: unknown) => {
      tool = t as Registered;
    },
  } as never);
  if (tool === undefined) throw new Error('tool did not register');
  return tool;
}

function stored(): { enabled?: boolean; tasks: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(STORE, 'utf8')) as never;
}

beforeEach(() => {
  fs.rmSync(path.dirname(STORE), { recursive: true, force: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('create_scheduled_task', () => {
  it('writes a task the app can read', async () => {
    const tool = register();
    const res = await tool.execute('c1', {
      name: 'Morning tests',
      prompt: 'Run the test suite and report failures.',
      frequency: 'weekdays',
      hour: 7,
      minute: 30,
    });
    expect(res.isError).toBe(false);
    const doc = stored();
    expect(doc.tasks).toHaveLength(1);
    expect(doc.tasks[0]).toMatchObject({
      name: 'Morning tests',
      frequency: 'weekdays',
      hour: 7,
      minute: 30,
      enabled: true,
    });
    expect(typeof doc.tasks[0]?.id).toBe('string');
  });

  it('APPENDS rather than replacing what is already scheduled', async () => {
    // The obvious bug: a model creating a second task wipes the first.
    const tool = register();
    await tool.execute('c1', { name: 'One', prompt: 'a', frequency: 'daily' });
    await tool.execute('c2', { name: 'Two', prompt: 'b', frequency: 'daily' });
    expect(stored().tasks.map((t) => t.name)).toEqual(['One', 'Two']);
  });

  it('states the time it defaulted to, so nobody discovers it at 9am', async () => {
    const tool = register();
    const res = await tool.execute('c1', { name: 'X', prompt: 'do a thing', frequency: 'daily' });
    expect(res.content[0]?.text).toContain('09:00');
  });

  it('refuses an empty prompt instead of scheduling nothing', async () => {
    const tool = register();
    const res = await tool.execute('c1', { name: 'X', prompt: '   ', frequency: 'daily' });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(STORE)).toBe(false);
  });

  it('names an unnamed task from its instruction', async () => {
    const tool = register();
    await tool.execute('c1', {
      name: '',
      prompt: 'Check disk space, then warn me',
      frequency: 'daily',
    });
    expect(stored().tasks[0]?.name).toBe('Check disk space');
  });

  it('warns when scheduling is switched off, rather than reporting success flatly', async () => {
    // Otherwise the model says "scheduled!" about something that cannot fire.
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify({ enabled: false, tasks: [] }));
    const tool = register();
    const res = await tool.execute('c1', { name: 'X', prompt: 'y', frequency: 'daily' });
    expect(res.content[0]?.text).toContain('switched off');
    expect(stored().enabled).toBe(false);
  });

  it('preserves the global switch when it appends', async () => {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify({ enabled: false, tasks: [] }));
    const tool = register();
    await tool.execute('c1', { name: 'X', prompt: 'y', frequency: 'daily' });
    expect(stored().enabled).toBe(false);
  });
});
