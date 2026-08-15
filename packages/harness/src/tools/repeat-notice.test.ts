/**
 * The repeat notice fires on a PROOF (identical call, identical output) and
 * never on a resemblance — because the run that motivated it contains both, and
 * the difference between them is the whole point.
 */
import { describe, expect, it } from 'vitest';
import { repeatNotice, resultText, withRepeatNotice } from './repeat-notice.js';

/** A fake tool whose output is decided by the test. */
function toolReturning(outputs: readonly string[]) {
  let i = 0;
  const calls: unknown[] = [];
  const tool = {
    async execute(..._args: never[]) {
      calls.push(_args[1]);
      const text = outputs[Math.min(i, outputs.length - 1)] ?? '';
      i += 1;
      return { content: [{ type: 'text', text }] };
    },
  };
  return { tool, calls };
}

const textOf = (r: unknown) => resultText(r);

describe('withRepeatNotice', () => {
  it('says nothing the first time a command is run', async () => {
    const { tool } = toolReturning(['/bin/ls']);
    const wrapped = withRepeatNotice(tool, 'bash');
    const out = await wrapped.execute('id' as never, { command: 'which ls' } as never);
    expect(textOf(out)).toBe('/bin/ls');
  });

  it('flags a byte-identical call that returned byte-identical output', async () => {
    const { tool } = toolReturning(['ls: no such file', 'ls: no such file']);
    const wrapped = withRepeatNotice(tool, 'bash');
    const args = { command: 'ls /opt/homebrew/bin/ls' } as never;
    await wrapped.execute('a' as never, args);
    const second = textOf(await wrapped.execute('b' as never, args));
    expect(second).toMatch(/same command, same output as 1 call ago/);
    expect(second).toMatch(/told you nothing new/);
    // The real output is still there, underneath the note.
    expect(second).toMatch(/ls: no such file/);
  });

  it('escalates once the same nothing has come back three times', async () => {
    const { tool } = toolReturning(['unchanged']);
    const wrapped = withRepeatNotice(tool, 'bash');
    const args = { command: 'ls x' } as never;
    await wrapped.execute('a' as never, args);
    await wrapped.execute('b' as never, args);
    const third = textOf(await wrapped.execute('c' as never, args));
    expect(third).toMatch(/run this exact command 3 times/);
    expect(third).toMatch(/move on/);
  });

  /*
   * THE CASE THAT MUST NOT FIRE. Run 14's early stretch was a search NARROWING:
   * each call differed and each answer differed, ending in a real discovery.
   * the user: "'similar calls' could be just narrowing a file search or something?"
   */
  it('stays silent while a search narrows', async () => {
    const { tool } = toolReturning([
      '/opt/homebrew/bin/convert\n/opt/homebrew/bin/magick',
      'total 4728\n7zz',
      '/opt/homebrew/Cellar/sevenzip/26.02/bin/7zz',
    ]);
    const wrapped = withRepeatNotice(tool, 'bash');
    for (const command of [
      'which convert magick libreoffice',
      'ls -la /opt/homebrew/Cellar/sevenzip/26.02/bin/',
      'find /opt/homebrew -name "7z*"',
    ]) {
      const out = textOf(await wrapped.execute('x' as never, { command } as never));
      expect(out).not.toMatch(/same command/);
    }
  });

  /*
   * POLLING IS LEGITIMATE. While the awaited thing has not happened the notice
   * is TRUE — nothing has changed — and the moment it happens the output differs
   * and the notice stops on its own. It must never block the retry.
   */
  it('goes quiet by itself when a polled command finally changes', async () => {
    const { tool, calls } = toolReturning(['not ready', 'not ready', 'ready']);
    const wrapped = withRepeatNotice(tool, 'bash');
    const args = { command: 'curl -s localhost:8080/health' } as never;
    await wrapped.execute('a' as never, args);
    expect(textOf(await wrapped.execute('b' as never, args))).toMatch(/same command/);
    const third = textOf(await wrapped.execute('c' as never, args));
    expect(third).toBe('ready');
    expect(third).not.toMatch(/same command/);
    // Every call still reached the tool — this notes, it never refuses.
    expect(calls).toHaveLength(3);
  });

  it('treats a different command with the same output as a different call', async () => {
    const { tool } = toolReturning(['same', 'same']);
    const wrapped = withRepeatNotice(tool, 'bash');
    await wrapped.execute('a' as never, { command: 'echo same' } as never);
    const out = textOf(await wrapped.execute('b' as never, { command: 'printf same' } as never));
    expect(out).not.toMatch(/same command/);
  });

  it('keeps no history across wrappers, so one agent cannot see another’s calls', async () => {
    const args = { command: 'ls' } as never;
    const a = withRepeatNotice(toolReturning(['x']).tool, 'bash');
    const b = withRepeatNotice(toolReturning(['x']).tool, 'bash');
    await a.execute('1' as never, args);
    expect(textOf(await b.execute('1' as never, args))).not.toMatch(/same command/);
  });
});

describe('resultText', () => {
  it('reads the shapes a tool result actually arrives in', () => {
    expect(resultText('plain')).toBe('plain');
    expect(resultText({ content: 'string content' })).toBe('string content');
    expect(
      resultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb');
    expect(resultText({ content: [{ type: 'image' }] })).toBe('');
    expect(resultText(null)).toBe('');
    expect(resultText(undefined)).toBe('');
  });
});

describe('repeatNotice wording', () => {
  it('is singular for one call ago', () => {
    expect(repeatNotice(2, 1)).toMatch(/1 call ago/);
    expect(repeatNotice(2, 4)).toMatch(/4 calls ago/);
  });
});
