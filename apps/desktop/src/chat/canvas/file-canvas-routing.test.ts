/**
 * Unit coverage for the pure round-7 canvas routers: file-write detection
 * (which tool calls write files, redirect parsing, path resolution) and
 * interactive-bash → terminal classification. No React / IPC here.
 */
import type { ChatMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { bashRedirectTarget, detectFileWrites, dirname, resolvePath } from './file-writes';
import { detectBashTerminals, isInteractiveCommand } from './terminal-routing';

type ToolCall = Extract<ContentBlock, { type: 'toolCall' }>;

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const assistant = (id: string, blocks: ContentBlock[]): ChatMsg =>
  ({ kind: 'assistant', id, blocks, timestamp: 0, isStreaming: false }) as ChatMsg;
const result = (id: string, out: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'x',
  text: out,
  isError: false,
  timestamp: 0,
});

describe('resolvePath', () => {
  it('joins a relative path onto the cwd and collapses . / ..', () => {
    expect(resolvePath('/home/p', 'src/a.ts')).toBe('/home/p/src/a.ts');
    expect(resolvePath('/home/p', './x/../y.ts')).toBe('/home/p/y.ts');
  });
  it('passes an absolute path through', () => {
    expect(resolvePath('/home/p', '/etc/hosts')).toBe('/etc/hosts');
  });
  it('handles a missing cwd', () => {
    expect(resolvePath(undefined, 'a/b.ts')).toBe('a/b.ts');
  });
});

describe('dirname', () => {
  it('returns the parent directory', () => {
    expect(dirname('/a/b/c.ts')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
  });
});

describe('bashRedirectTarget', () => {
  it('finds a `>` / `>>` redirect target', () => {
    expect(bashRedirectTarget('echo hi > out.txt')).toBe('out.txt');
    expect(bashRedirectTarget('cat a >> log/app.log')).toBe('log/app.log');
  });
  it('finds a tee target and ignores /dev/null + fd dups', () => {
    expect(bashRedirectTarget('foo | tee -a build.log')).toBe('build.log');
    expect(bashRedirectTarget('noisy 2>&1 > /dev/null')).toBeUndefined();
  });
  it('returns undefined for a command with no redirect', () => {
    expect(bashRedirectTarget('ls -la /tmp')).toBeUndefined();
  });
  /* SEEN: a python one-liner's `> 60]))` opened a tab called `60])}` — a
   * comparison inside the quoted program, read as a redirect. */
  it('ignores a `>` inside quotes — a comparison is not a redirect', () => {
    expect(
      bashRedirectTarget(`python3 -c "print(len([u for u in d if u['age'] > 60]))"`),
    ).toBeUndefined();
    expect(bashRedirectTarget("awk '$3 > 100 {print}' data.csv")).toBeUndefined();
    // …while a real redirect after the quoted program still counts.
    expect(bashRedirectTarget(`python3 -c "print(1 > 0)" > result.txt`)).toBe('result.txt');
  });
  it('ignores everything inside a heredoc body', () => {
    expect(bashRedirectTarget("python3 << 'EOF'\nx = 3 > 2\nprint(x)\nEOF")).toBeUndefined();
    expect(bashRedirectTarget("cat << 'EOF' > notes.md\na > b\nEOF")).toBe('notes.md');
  });
  it('does not take a code fragment for a path', () => {
    expect(bashRedirectTarget('echo x > out[1].txt')).toBeUndefined();
  });
});

describe('detectFileWrites', () => {
  it('detects a whole-file write with its content hint (running until a result)', () => {
    const msgs = [assistant('a1', [call('c1', 'write', { path: 'a.ts', content: 'hi' })])];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.path).toBe('/proj/a.ts');
    expect(ev?.filename).toBe('a.ts');
    expect(ev?.running).toBe(true);
    expect(ev?.contentHint).toBe('hi');
  });

  it('detects a str_replace edit as an EDIT HUNK (old/new strings), no content hint', () => {
    const msgs = [
      assistant('a1', [call('c1', 'edit', { path: '/x/b.ts', oldText: 'a', newText: 'b' })]),
      result('c1', 'ok'),
    ];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.path).toBe('/x/b.ts');
    expect(ev?.running).toBe(false);
    expect(ev?.contentHint).toBeUndefined();
    // The hunk drives the canvas EDIT MOTION: the old text forward-deletes out
    // of the file and the new text types in where it stood.
    expect(ev?.edit).toEqual({ oldText: 'a', newText: 'b' });
    expect(ev?.hunks).toEqual([{ oldText: 'a', newText: 'b' }]);
  });

  it('detects EVERY hunk of a multi-edit call, in the order the tool listed them', () => {
    const msgs = [
      assistant('a1', [
        call('c1', 'edit', {
          path: '/x/b.ts',
          edits: [
            { old_string: 'one', new_string: '1' },
            { old_string: 'two', new_string: '2' },
            { old_string: 'three', new_string: '3' },
          ],
        }),
      ]),
    ];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.hunks).toEqual([
      { oldText: 'one', newText: '1' },
      { oldText: 'two', newText: '2' },
      { oldText: 'three', newText: '3' },
    ]);
    // `edit` stays the FIRST hunk, so the fallback diff still has something.
    expect(ev?.edit).toEqual({ oldText: 'one', newText: '1' });
  });

  it('leaves `hunks` unset while the arguments are still arriving', () => {
    // The motion cannot be planned from a half-arrived `old_string` — it would
    // delete the wrong text. `hunks` appearing IS the "arguments are complete"
    // signal the canvas waits on.
    const streaming = assistant('a1', [
      {
        type: 'toolCall',
        id: 'c1',
        name: 'str_replace',
        arguments: {},
        argsText: '{"path":"b.ts","old_string":"foo","new_string":"ba',
      } as ContentBlock,
    ]);
    const [ev] = detectFileWrites([streaming], '/proj');
    expect(ev?.edit).toEqual({ oldText: 'foo', newText: 'ba' });
    expect(ev?.hunks).toBeUndefined();
  });

  it('reads a STREAMING str_replace hunk from argsText (path closed, new_string partial)', () => {
    const streaming = assistant('a1', [
      {
        type: 'toolCall',
        id: 'c1',
        name: 'str_replace',
        arguments: {},
        argsText: '{"path":"b.ts","old_string":"foo","new_string":"ba',
      } as ContentBlock,
    ]);
    const [ev] = detectFileWrites([streaming], '/proj');
    expect(ev?.path).toBe('/proj/b.ts');
    expect(ev?.running).toBe(true);
    expect(ev?.contentHint).toBeUndefined();
    // Old string fully arrived, new string still streaming — both feed the diff.
    expect(ev?.edit).toEqual({ oldText: 'foo', newText: 'ba' });
  });

  it('keeps a whole-file write as a content hint (NOT an edit hunk)', () => {
    const msgs = [assistant('a1', [call('c1', 'write', { path: 'a.ts', content: 'hello' })])];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.contentHint).toBe('hello');
    expect(ev?.edit).toBeUndefined();
  });

  it('detects a bash redirect write and dedupes by path (last write wins)', () => {
    const msgs = [
      assistant('a1', [call('c1', 'bash', { command: 'echo one > note.md' })]),
      assistant('a2', [call('c2', 'bash', { command: 'echo two >> note.md' })]),
    ];
    const events = detectFileWrites(msgs, '/proj');
    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('/proj/note.md');
    expect(events[0]?.callId).toBe('c2');
  });

  it('ignores non-writing tools', () => {
    const msgs = [assistant('a1', [call('c1', 'bash', { command: 'ls -la' })])];
    expect(detectFileWrites(msgs, '/proj')).toHaveLength(0);
  });
});

describe('isInteractiveCommand', () => {
  it('matches dev servers, watchers, and REPLs', () => {
    expect(isInteractiveCommand('npm run dev')).toBe(true);
    expect(isInteractiveCommand('pnpm dev')).toBe(true);
    expect(isInteractiveCommand('vite')).toBe(true);
    expect(isInteractiveCommand('tail -f app.log')).toBe(true);
    expect(isInteractiveCommand('python3 -m http.server 8000')).toBe(true);
    expect(isInteractiveCommand('node server.js &')).toBe(true);
  });
  it('rejects ordinary one-shot commands', () => {
    expect(isInteractiveCommand('ls -la')).toBe(false);
    expect(isInteractiveCommand('git status')).toBe(false);
    expect(isInteractiveCommand('echo hi')).toBe(false);
  });
});

describe('detectBashTerminals', () => {
  it('mirrors only interactive bash calls, carrying output + running state', () => {
    const msgs = [
      assistant('a1', [call('c1', 'bash', { command: 'ls' })]),
      assistant('a2', [call('c2', 'bash', { command: 'npm run dev' })]),
      result('c2', 'VITE ready'),
    ];
    const events = detectBashTerminals(msgs);
    expect(events).toHaveLength(1);
    expect(events[0]?.callId).toBe('c2');
    expect(events[0]?.output).toBe('VITE ready');
    expect(events[0]?.running).toBe(false);
  });
});

describe('detectFileWrites — where the tool said it wrote', () => {
  /* SEEN 2026-09-13 (the user): every written file of a chat opened as "Could not
   * read this file". The model wrote `hi-8/x.md` inside a working folder that
   * WAS …/hi-8; the tab resolved the call's path against pi's cwd (one folder
   * up) while the tool reported the real file. */
  it("keys the tab by the tool result's absolute path over the call's own", () => {
    const msgs = [
      assistant('a1', [call('c1', 'write', { path: 'hi-8/x.md', content: '# x' })]),
      result('c1', 'Successfully wrote 3 bytes to /Users/user/Bobble/hi-8/x.md'),
    ];
    const [ev] = detectFileWrites(msgs, '/Users/user/Bobble');
    expect(ev?.path).toBe('/Users/user/Bobble/hi-8/x.md');
    expect(ev?.running).toBe(false);
  });

  it('reads the path out of write and edit results, and nothing out of other text', async () => {
    const { reportedWritePath } = await import('../reported-path');
    expect(reportedWritePath('Successfully wrote 988 bytes to /a/b c/d.md')).toBe('/a/b c/d.md');
    expect(reportedWritePath('Successfully replaced 2 block(s) in /a/b.ts\n(note)')).toBe(
      '/a/b.ts',
    );
    expect(reportedWritePath('EISDIR: illegal operation on a directory')).toBeUndefined();
    expect(reportedWritePath('wrote to /x')).toBeUndefined();
  });
});

describe('detectFileWrites — a refused write is not a file', () => {
  /* SEEN: the handmade-media guard refused create_illustrations.py and the
   * Activity tab opened "Could not read this file" for it anyway. */
  it('drops a whole-file write whose result was an error, keeps a failed edit', () => {
    const msgs: ChatMsg[] = [
      assistant('a1', [
        call('c1', 'write', { path: 'create_illustrations.py', content: 'from PIL import Image' }),
      ]),
      {
        kind: 'toolResult',
        id: 'r1',
        toolCallId: 'c1',
        assistantId: 'a1',
        toolName: 'write',
        text: 'Not written: …',
        isError: true,
        timestamp: 0,
      } as ChatMsg,
      assistant('a2', [
        call('c2', 'edit', { path: 'app.py', edits: [{ oldText: 'a', newText: 'b' }] }),
      ]),
      {
        kind: 'toolResult',
        id: 'r2',
        toolCallId: 'c2',
        assistantId: 'a2',
        toolName: 'edit',
        text: 'Could not find the exact text',
        isError: true,
        timestamp: 0,
      } as ChatMsg,
    ];
    const paths = detectFileWrites(msgs, '/proj').map((e) => e.path);
    expect(paths).toEqual(['/proj/app.py']);
  });
});
