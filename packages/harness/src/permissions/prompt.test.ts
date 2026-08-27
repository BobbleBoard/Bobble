/**
 * b17: three answers, and a grant that means what the button says.
 *
 * `ctx.ui.confirm` returns a boolean — two outcomes for a decision with three.
 * And the named hazard: the "allow for this chat" set lives in the closure of a
 * PI CHILD, which outlives a chat. Neither a new chat nor a switch respawns it,
 * so a grant kept and never cleared would silently apply to every later chat.
 */
import { describe, expect, it } from 'vitest';
import {
  decodePermission,
  encodePermission,
  parsePermissionAnswer,
  permissionKey,
} from './prompt.js';

const spec = {
  v: 1 as const,
  toolName: 'bash',
  reason: 'this deletes things',
  args: { command: 'rm -rf build' },
};

describe('the wire contract', () => {
  it('round-trips', () => {
    expect(decodePermission(encodePermission(spec))).toEqual(spec);
  });

  it('ignores a placeholder that is not one of ours', () => {
    expect(decodePermission('Type your answer')).toBeNull();
    expect(decodePermission('')).toBeNull();
  });

  it('rejects a malformed or future-version payload rather than guessing', () => {
    expect(decodePermission('PI_DESKTOP_PERMISSION::v1::{not json')).toBeNull();
    expect(decodePermission(`PI_DESKTOP_PERMISSION::v1::${JSON.stringify({ v: 2 })}`)).toBeNull();
  });

  it('carries the raw arguments — the renderer builds the preview', () => {
    const back = decodePermission(encodePermission(spec));
    expect(back?.args).toEqual({ command: 'rm -rf build' });
  });
});

describe('parsePermissionAnswer', () => {
  it('reads the three answers', () => {
    expect(parsePermissionAnswer('once')).toBe('once');
    expect(parsePermissionAnswer('session')).toBe('session');
    expect(parsePermissionAnswer('deny')).toBe('deny');
  });

  it('treats ANYTHING unrecognised as a refusal', () => {
    // A dismissed dialog, an empty string from a TUI with no decoder, a typo.
    // Defaulting the other way turns every unknown into a yes.
    for (const v of ['', '   ', null, undefined, 'maybe', 'ok?', '{}']) {
      expect(parsePermissionAnswer(v)).toBe('deny');
    }
  });

  it('accepts the plain words a TUI user would type', () => {
    expect(parsePermissionAnswer('yes')).toBe('once');
    expect(parsePermissionAnswer('Y')).toBe('once');
    expect(parsePermissionAnswer('always')).toBe('session');
  });
});

describe('permissionKey', () => {
  it('keys on the salient argument, not the whole blob', () => {
    // Allowing `rm -rf build` must not also allow `rm -rf /`.
    expect(permissionKey('bash', { command: 'rm -rf build' })).not.toBe(
      permissionKey('bash', { command: 'rm -rf /' }),
    );
  });

  it('matches the same call again, which is what makes a grant useful', () => {
    expect(permissionKey('bash', { command: 'npm test' })).toBe(
      permissionKey('bash', { command: 'npm test' }),
    );
  });

  it('separates tools that share an argument', () => {
    expect(permissionKey('write', { path: '/x' })).not.toBe(permissionKey('edit', { path: '/x' }));
  });

  it('handles the argument shapes the file tools use', () => {
    expect(permissionKey('write', { path: '/a' })).toContain('/a');
    expect(permissionKey('edit', { file_path: '/b' })).toContain('/b');
  });
});
