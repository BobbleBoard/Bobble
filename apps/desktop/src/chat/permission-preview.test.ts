/**
 * b17: what the prompt shows.
 *
 * The old prompt printed the first 200 characters of the raw arguments — which
 * for a write or an edit is the wrong field entirely, and unreadable exactly
 * when the decision matters.
 */
import { describe, expect, it } from 'vitest';
import { previewFor } from './PermissionDialog';

describe('previewFor', () => {
  it('shows a bash call as its command', () => {
    const p = previewFor('bash', { command: 'rm -rf /' });
    expect(p.kind).toBe('command');
    expect(p.body).toBe('rm -rf /');
  });

  it('shows a write as its CONTENT, with the path beside it', () => {
    const p = previewFor('write', { path: '/tmp/x.ts', content: 'export const a = 1;' });
    expect(p.kind).toBe('write');
    expect(p.path).toBe('/tmp/x.ts');
    expect(p.body).toContain('export const a = 1;');
  });

  it('shows an edit as a diff, not as two opaque strings', () => {
    const p = previewFor('edit', {
      file_path: '/a.ts',
      oldText: 'let x = 1;',
      newText: 'let x = 2;',
    });
    expect(p.kind).toBe('edit');
    expect(p.body).toContain('- let x = 1;');
    expect(p.body).toContain('+ let x = 2;');
  });

  it('accepts both argument spellings the file tools use', () => {
    expect(previewFor('edit', { old_string: 'a', new_string: 'b' }).body).toContain('- a');
    expect(previewFor('write', { file_path: '/p', text: 'hi' }).path).toBe('/p');
  });

  it('clips a huge body and says how much it clipped', () => {
    const p = previewFor('write', { path: '/x', content: 'y'.repeat(20_000) });
    expect(p.body.length).toBeLessThan(4200);
    expect(p.body).toContain('more characters');
  });

  it('falls back to formatted arguments, and says it is a fallback', () => {
    const p = previewFor('browser_click', { index: 3 });
    expect(p.kind).toBe('none');
    expect(p.body).toContain('"index": 3');
  });

  it('does not crash on an empty call', () => {
    expect(previewFor('bash', {}).body).toBe('');
    expect(previewFor('write', {}).kind).toBe('write');
  });
});
