import { describe, expect, it } from 'vitest';
import { inlineTransitionName, inlineTransitionStyle } from './inline-transition.ts';

describe('inlineTransitionName', () => {
  it('is a CSS identifier, stable for a key, different between keys', () => {
    const a = inlineTransitionName('present:/Users/x/units sold.svg');
    expect(a).toMatch(/^pd-inline-[0-9a-f]+$/);
    expect(inlineTransitionName('present:/Users/x/units sold.svg')).toBe(a);
    expect(inlineTransitionName('present:/Users/x/other.svg')).not.toBe(a);
    expect(inlineTransitionStyle('k')).toEqual({
      viewTransitionName: inlineTransitionName('k'),
      viewTransitionClass: 'pd-inline',
    });
  });
});
