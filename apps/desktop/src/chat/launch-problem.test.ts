import { describe, expect, it } from 'vitest';
import { describeLaunchProblem } from './launch-problem';

describe('describeLaunchProblem — a held message says why the model did not start', () => {
  it('nothing downloaded sends you to Models', () => {
    const p = describeLaunchProblem({ kind: 'no-model' });
    expect(p.fix).toBe('models');
    expect(p.title).toMatch(/no model on this Mac/);
  });
  it('a slow load offers to keep waiting', () => {
    const p = describeLaunchProblem({ kind: 'timeout', modelName: 'Qwen 3.8 27B' });
    expect(p.title).toBe('Qwen 3.8 27B is taking more than five minutes to load.');
    expect(p.fix).toBe('retry');
  });
  it('names the cause it can act on, never the supervisor’s words', () => {
    const cases: Array<[string, RegExp, string]> = [
      [
        'refusing to launch: needs 21.4 GB, 9.8 GB free (fit reserve 30%)',
        /not enough free memory/,
        'retry',
      ],
      ['failed to fetch vision projector: fetch failed', /could not reach the internet/, 'retry'],
      ['rapid-mlx is not installed', /engine it runs on is not installed/, 'other-model'],
      ['ENOENT: no such file or directory, open model.gguf', /not on this Mac any more/, 'models'],
      ['llama-server never became healthy on port 52011', /did not finish loading/, 'retry'],
      ['something nobody planned for', /stopped while it was loading/, 'retry'],
    ];
    for (const [detail, body, fix] of cases) {
      const p = describeLaunchProblem({ kind: 'failed', modelName: 'Gemma 4', detail });
      expect(p.title).toBe('Gemma 4 could not start.');
      expect(p.body, detail).toMatch(body);
      expect(p.fix, detail).toBe(fix);
      expect(p.body).not.toContain(detail);
      expect(p.detail).toBe(detail);
    }
  });
});
