// @vitest-environment jsdom
/**
 * ONE "Activity" tab — the decision, and the persistence.
 *
 * Three things are worth a test here and they are exactly the three the user named:
 *
 *  1. WHAT THE TAB BECOMES. The newest tool call decides, across kinds, so a
 *     file written after a command shows the file and a command run after that
 *     shows the terminal again. Deciding "file, else terminal" pins the tab to
 *     whichever came first, which is the bug this replaces.
 *  2. WHICH BASH IS BASH. `ls -la` is a terminal; `mac snapshot` is the mac tool
 *     wearing a command and must never open one.
 *  3. THAT NOTHING IS LOST. The terminal is every command the thread has run, so
 *     `ls -la` and its output stay above the next command as that one is typed —
 *     and the mirror text only ever GROWS, which is what lets the xterm append
 *     instead of resetting (native-surfaces' #writeMirror).
 *
 * Driven against a REAL CanvasController, so "it morphs in place" is checked as
 * the tab count and the tab id rather than as an intention.
 */
import { CanvasController } from '@pi-desktop/canvas';
import type { ChatMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TAB_KEY,
  ACTIVITY_TITLE,
  activityMirrorText,
  activitySpec,
  detectActivity,
  morphActivityTab,
} from './activity-routing';

type ToolCall = Extract<ContentBlock, { type: 'toolCall' }>;

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const streamingCall = (id: string, name: string, argsText: string): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: {},
  argsText,
});
const assistant = (id: string, blocks: ContentBlock[]): ChatMsg =>
  ({ kind: 'assistant', id, blocks, timestamp: 0, isStreaming: false }) as ChatMsg;
const result = (id: string, text: string): ToolResultMsg => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: 'bash',
  text,
  isError: false,
  timestamp: 0,
});
const user = (id: string): ChatMsg =>
  ({ kind: 'user', id, text: 'go', timestamp: 0 }) as unknown as ChatMsg;

const CWD = '/Users/user/proj';

describe('detectActivity — which bash is bash', () => {
  it('collects a real shell command', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]), result('c1', 'total 8')],
      {},
      CWD,
    );
    expect(stream.commands).toEqual([
      { callId: 'c1', command: 'ls -la', output: 'total 8', running: false },
    ]);
    expect(stream.focus?.kind).toBe('terminal');
  });

  it('ignores a registered CLI tool invoked as a command', () => {
    const stream = detectActivity(
      [
        assistant('a1', [call('c1', 'bash', { command: 'media generate image "a fox"' })]),
        result('c1', 'wrote /tmp/fox.png'),
      ],
      {},
      CWD,
    );
    expect(stream.commands).toEqual([]);
    expect(stream.focus).toBeUndefined();
  });

  it('marks a command with no result yet as running, and shows partial output', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'bash', { command: 'npm run build' })])],
      { c1: 'vite v7…' },
      CWD,
    );
    expect(stream.commands[0]).toEqual({
      callId: 'c1',
      command: 'npm run build',
      output: 'vite v7…',
      running: true,
    });
  });

  it('shows a command while its arguments are still streaming', () => {
    // the user: the previous output stays visible "above this next one AS IT'S BEING
    // TYPED" — which only means anything if a half-arrived command is shown.
    const stream = detectActivity(
      [assistant('a1', [streamingCall('c1', 'bash', '{"command": "git sta')])],
      {},
      CWD,
    );
    expect(stream.commands[0]?.command).toBe('git sta');
    expect(stream.commands[0]?.running).toBe(true);
  });
});

describe('detectActivity — when the turn is over, a look is not the work', () => {
  /* m03 in the canvas assessment: the page was in the tab, the user asked for a
   * change, the model edited index.html and ran `cat index.html` — and the tab
   * showed the cat output for good. */
  const messages: ChatMsg[] = [
    user('u1'),
    assistant('a1', [
      call('c1', 'edit', { path: 'site/index.html', oldText: 'Count', newText: 'Clicks' }),
    ]),
    result('c1', 'ok'),
    assistant('a2', [call('c2', 'bash', { command: 'cat site/index.html' })]),
    result('c2', '<html>…'),
  ];

  it('while the model works, newest still wins — the cat shows', () => {
    const stream = detectActivity(messages, {}, CWD, { settled: false });
    expect(stream.focus?.kind).toBe('terminal');
  });

  it('once settled, a trailing look-only command gives way to what was made', () => {
    const stream = detectActivity(messages, {}, CWD, { settled: true });
    expect(stream.focus?.kind).toBe('file');
    expect(stream.focus?.kind === 'file' && stream.focus.write.path).toBe(`${CWD}/site/index.html`);
    // …and the cat is still in the terminal's scrollback.
    expect(stream.commands.map((c) => c.command)).toEqual(['cat site/index.html']);
  });

  it('a trailing command that DOES something keeps the terminal', () => {
    const stream = detectActivity(
      [
        ...messages,
        assistant('a3', [call('c3', 'bash', { command: 'npm run build' })]),
        result('c3', 'built'),
      ],
      {},
      CWD,
      { settled: true },
    );
    expect(stream.focus?.kind).toBe('terminal');
  });

  it('a look with nothing made before it stays a look', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]), result('c1', 'a b')],
      {},
      CWD,
      { settled: true },
    );
    expect(stream.focus?.kind).toBe('terminal');
  });
});

describe('detectActivity — newest wins, across kinds', () => {
  const messages: ChatMsg[] = [
    assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
    result('c1', 'a.ts\nb.ts'),
    assistant('a2', [call('c2', 'write', { path: 'notes.md', content: '# notes' })]),
    result('c2', 'ok'),
    assistant('a3', [call('c3', 'bash', { command: 'git status' })]),
    result('c3', 'clean'),
  ];

  it('is the terminal when a command ran last', () => {
    const stream = detectActivity(messages, {}, CWD);
    expect(stream.focus?.kind).toBe('terminal');
    expect(stream.focus?.kind === 'terminal' && stream.focus.command.command).toBe('git status');
  });

  it('is the file when the write came last', () => {
    const stream = detectActivity(messages.slice(0, 4), {}, CWD);
    expect(stream.focus?.kind).toBe('file');
    expect(stream.focus?.kind === 'file' && stream.focus.write.path).toBe(`${CWD}/notes.md`);
  });

  it('is the browser when a browser call came last', () => {
    const stream = detectActivity(
      [...messages, assistant('a4', [call('c4', 'browser_navigate', { url: 'https://ex.com/x' })])],
      {},
      CWD,
    );
    expect(stream.focus?.kind).toBe('browser');
    expect(stream.focus?.kind === 'browser' && stream.focus.label).toBe('ex.com');
  });

  it('gives a redirect write to the FILE, not to the command that wrote it', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'bash', { command: 'echo hi > notes.md' })]), result('c1', '')],
      {},
      CWD,
    );
    // The command is still in the scrollback; the tab shows the file.
    expect(stream.commands).toHaveLength(1);
    expect(stream.focus?.kind).toBe('file');
  });

  it('has no focus at all before anything happened', () => {
    expect(detectActivity([user('u1')], {}, CWD).focus).toBeUndefined();
  });
});

describe('activityMirrorText — nothing is lost', () => {
  const ls = { callId: 'c1', command: 'ls -la', output: '', running: true };

  it('keeps every command, oldest first', () => {
    const text = activityMirrorText(
      [
        { ...ls, output: 'total 8\na.ts', running: false },
        { callId: 'c2', command: 'git status', output: '', running: true },
      ],
      CWD,
    );
    expect(text).toContain('ls -la');
    expect(text).toContain('total 8');
    expect(text.indexOf('ls -la')).toBeLessThan(text.indexOf('git status'));
  });

  it('names the working directory in the prompt, not a bare $', () => {
    expect(activityMirrorText([ls], CWD)).toContain('bobble proj $ ls -la');
  });

  it('ONLY GROWS as output arrives — the xterm appends instead of resetting', () => {
    const running = activityMirrorText([ls], CWD);
    const done = activityMirrorText([{ ...ls, output: 'total 8', running: false }], CWD);
    expect(done.startsWith(running)).toBe(true);
  });

  it('ONLY GROWS when the next command starts being typed', () => {
    const before = activityMirrorText([{ ...ls, output: 'total 8', running: false }], CWD);
    const after = activityMirrorText(
      [
        { ...ls, output: 'total 8', running: false },
        { callId: 'c2', command: 'git st', output: '', running: true },
      ],
      CWD,
    );
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('git st');
  });
});

describe('activitySpec', () => {
  it('always keeps the name "Activity" and puts the detail in the subtitle', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'bash', { command: 'git status --short' })])],
      {},
      CWD,
    );
    const spec = activitySpec(stream, CWD);
    expect(spec?.title).toBe(ACTIVITY_TITLE);
    expect(spec?.key).toBe(ACTIVITY_TAB_KEY);
    expect(spec?.kind).toBe('terminal');
    expect(spec?.subtitle).toBe('git status --short');
    expect(spec?.data?.mirror).toBe(true);
  });

  it('points a file spec at the path, with a breadcrumb under the project', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'write', { path: 'src/app.ts', content: 'x' })])],
      {},
      CWD,
    );
    const spec = activitySpec(stream, CWD);
    expect(spec?.kind).toBe('file');
    expect(spec?.filePath).toBe(`${CWD}/src/app.ts`);
    expect(spec?.subtitle).toBe('app.ts');
    expect(spec?.breadcrumb).toEqual(['proj', 'src', 'app.ts']);
    expect(spec?.streaming).toBe(true); // no result yet
  });

  it('caps the breadcrumb at its tail — a rail cannot read nine ellipses', () => {
    const stream = detectActivity(
      [assistant('a1', [call('c1', 'write', { path: '/var/folders/T/pd-home-x/proj/notes.md' })])],
      {},
      undefined,
    );
    expect(activitySpec(stream, undefined)?.breadcrumb).toEqual(['pd-home-x', 'proj', 'notes.md']);
  });

  it('shows a finished binary write as its own modality, not as mojibake', () => {
    const stream = detectActivity(
      [
        assistant('a1', [call('c1', 'write', { path: 'out/chart.png', content: 'x' })]),
        result('c1', 'ok'),
      ],
      {},
      CWD,
    );
    const spec = activitySpec(stream, CWD);
    expect(spec?.kind).toBe('image');
    expect(spec?.mediaType).toBe('PNG');
  });

  it('has nothing to say before the first tool call', () => {
    expect(activitySpec({ commands: [] }, CWD)).toBeUndefined();
  });
});

describe('morphActivityTab — one tab, morphing in place', () => {
  const specFor = (messages: ChatMsg[]) => {
    const spec = activitySpec(detectActivity(messages, {}, CWD), CWD);
    if (spec === undefined) throw new Error('no spec');
    return spec;
  };

  it('creates the tab once and then never adds another', () => {
    const c = new CanvasController();
    const first = morphActivityTab(
      c,
      specFor([assistant('a1', [call('c1', 'bash', { command: 'ls -la' })])]),
    );
    expect(first.created).toBe(true);

    const second = morphActivityTab(
      c,
      specFor([
        assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
        result('c1', 'total 8'),
        assistant('a2', [call('c2', 'write', { path: 'notes.md', content: 'hi' })]),
      ]),
    );
    expect(second.created).toBe(false);
    // SAME id — that is what keeps the xterm and any native view alive.
    expect(second.id).toBe(first.id);
    expect(c.getState().tabs).toHaveLength(1);
    expect(c.getState().tabs[0]?.kind).toBe('file');
    expect(c.getState().tabs[0]?.title).toBe(ACTIVITY_TITLE);
  });

  it('drops what the previous surface left behind when the kind changes', () => {
    const c = new CanvasController();
    morphActivityTab(c, specFor([assistant('a1', [call('c1', 'bash', { command: 'ls -la' })])]));
    expect(c.getState().tabs[0]?.data?.mirrorText).toBeTypeOf('string');

    morphActivityTab(
      c,
      specFor([
        assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
        result('c1', 'total 8'),
        assistant('a2', [call('c2', 'write', { path: 'notes.md', content: 'hi' })]),
      ]),
    );
    const tab = c.getState().tabs[0];
    expect(tab?.kind).toBe('file');
    // No mirror riding along on a file tab, and no stale content.
    expect(tab?.data).toBeUndefined();
    expect(tab?.artifact).toBeUndefined();
    expect(tab?.filePath).toBe(`${CWD}/notes.md`);
  });

  it('re-points a file tab at a DIFFERENT file without showing the old contents', () => {
    const c = new CanvasController();
    const messages: ChatMsg[] = [
      assistant('a1', [call('c1', 'write', { path: 'a.md', content: 'AAA' })]),
      result('c1', 'ok'),
    ];
    morphActivityTab(c, specFor(messages));
    const id = c.getState().tabs[0]?.id ?? '';
    c.updateTab(id, {
      artifact: { id: 'x', content: { kind: 'markdown', text: 'AAA' } },
    });

    morphActivityTab(
      c,
      specFor([
        ...messages,
        assistant('a2', [call('c2', 'write', { path: 'b.md', content: 'BBB' })]),
      ]),
    );
    const tab = c.getState().tabs[0];
    expect(tab?.filePath).toBe(`${CWD}/b.md`);
    expect(tab?.artifact).toBeUndefined();
  });

  it('THE SCROLLBACK SURVIVES a morph away and back', () => {
    // the user: "if it runs ls -la we get shown the result there then it writes a
    // file, then it runs some other terminal command we still see above this
    // next one … the ls -la output and command from before."
    const c = new CanvasController();
    const step1: ChatMsg[] = [
      assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
      result('c1', 'total 8\na.ts'),
    ];
    morphActivityTab(c, specFor(step1));

    const step2: ChatMsg[] = [
      ...step1,
      assistant('a2', [call('c2', 'write', { path: 'notes.md', content: 'hi' })]),
      result('c2', 'ok'),
    ];
    morphActivityTab(c, specFor(step2));
    expect(c.getState().tabs[0]?.kind).toBe('file');

    const step3: ChatMsg[] = [
      ...step2,
      assistant('a3', [call('c3', 'bash', { command: 'git st' })]),
    ];
    morphActivityTab(c, specFor(step3));
    const mirror = c.getState().tabs[0]?.data?.mirrorText as string;
    expect(mirror).toContain('ls -la');
    expect(mirror).toContain('total 8');
    expect(mirror).toContain('git st');
    expect(mirror.indexOf('total 8')).toBeLessThan(mirror.indexOf('git st'));
    expect(c.getState().tabs).toHaveLength(1);
  });

  it('a quiet tick commits nothing (no re-render storm, no #185 shape)', () => {
    const c = new CanvasController();
    const messages: ChatMsg[] = [
      assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
      result('c1', 'total 8'),
    ];
    morphActivityTab(c, specFor(messages));
    const before = c.getState();
    morphActivityTab(c, specFor(messages));
    expect(c.getState()).toBe(before);
  });
});
