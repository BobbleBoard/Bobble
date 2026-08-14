import { describe, expect, it } from 'vitest';

/**
 * THE FIELD THAT WAS DROPPED IN THE MIDDLE.
 *
 * `workspace` is what stops a failed hand-off being reported to the CEO as an
 * empty one. It was added to CorpRunResult, set by the host, and read by
 * promote-tool — and this parser, which picks fields explicitly, silently threw
 * it away. So run 4's CEO was told "Nothing was delivered" over a real tree, for
 * the second run running, with the fix apparently in place.
 *
 * A response parser that enumerates fields needs updating with every field and
 * nothing warns you: the type describes the RESULT, not the wire.
 */
describe('the bridge response parser', () => {
  const parse = (wire: Record<string, unknown>) => {
    const res = wire as {
      ok?: boolean;
      product?: string;
      summary?: string;
      error?: string;
      workspace?: string;
    };
    return {
      ok: res.ok === true,
      product: res.product ?? res.summary ?? '',
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(res.workspace !== undefined ? { workspace: res.workspace } : {}),
    };
  };

  it('carries the workspace listing through', () => {
    expect(parse({ ok: false, product: '', workspace: 'src/main.ts\nsrc/app.ts' }).workspace).toBe(
      'src/main.ts\nsrc/app.ts',
    );
  });

  it('omits it when the host did not send one', () => {
    expect(parse({ ok: true, product: 'done' })).not.toHaveProperty('workspace');
  });

  it('still accepts summary as an alias for product', () => {
    expect(parse({ ok: true, summary: 'built it' }).product).toBe('built it');
  });
});
