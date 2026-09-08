/**
 * The base prompt pi hands over is written for pi. Two parts of it are about
 * pi rather than about this app, and both are paid for on every single turn.
 */
import { describe, expect, it } from 'vitest';
import { BOBBLE_IDENTITY, stripPiIdentity } from './capability-prompt';

/* The real opening of pi 0.68.1's base prompt, verbatim. */
const BASE = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)
- Use read to examine files instead of cat or sed.
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /Applications/Bobble.app/Contents/Resources/app.asar/node_modules/@mariozechner/pi-coding-agent/README.md
- Additional docs: /Applications/.../docs
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
Current date: 2026-09-07
Current working directory: /Users/user/Projects`;

describe('stripPiIdentity', () => {
  const out = stripPiIdentity(BASE);

  it('drops the coding-assistant identity', () => {
    expect(out).not.toContain('expert coding assistant');
    expect(out).not.toContain('coding agent harness');
  });

  it('says what this actually is instead', () => {
    expect(out).toContain(BOBBLE_IDENTITY);
  });

  it('drops the pi documentation block, paths and all', () => {
    expect(out).not.toContain('Pi documentation');
    expect(out).not.toContain('pi-coding-agent/README.md');
    expect(out).not.toContain('follow .md cross-references');
  });

  it('keeps the guidelines that are about doing the work', () => {
    expect(out).toContain('Use read to examine files instead of cat or sed.');
    expect(out).toContain('Be concise in your responses');
  });

  it('keeps the date and working directory, which the turn needs', () => {
    expect(out).toContain('Current date: 2026-09-07');
    expect(out).toContain('Current working directory: /Users/user/Projects');
  });

  it('is idempotent, and leaves an unrecognised base alone', () => {
    expect(stripPiIdentity(out)).toBe(out);
    expect(stripPiIdentity('Something else entirely.')).toBe('Something else entirely.');
  });

  it('leaves no triple blank lines where it cut', () => {
    expect(out).not.toMatch(/\n{3,}/);
  });
});
