import { describe, expect, it } from 'vitest';
import { parseTqdm } from './tqdm';

describe('parseTqdm', () => {
  it('reads the step counter off a tqdm frame', () => {
    expect(parseTqdm('46%|████▋     | 11/24 [01:01<01:06,  5.08s/it]')).toEqual({
      step: 11,
      total: 24,
    });
    expect(parseTqdm('100%|██████████| 24/24 [02:02<00:00,  5.09s/it]')).toEqual({
      step: 24,
      total: 24,
    });
  });

  it('takes the last frame of a carriage-returned line', () => {
    const line =
      '  4%|▍ | 1/24 [00:05<01:55, 5.0s/it]\r  8%|▊ | 2/24 [00:10<01:50, 5.0s/it]\r 12%|█▎| 3/24 [00:15<01:45, 5.0s/it]';
    expect(parseTqdm(line)).toEqual({ step: 3, total: 24 });
  });

  it('is not fooled by a download ticker or ordinary logging', () => {
    expect(
      parseTqdm('model.safetensors:  46%|████▋ | 1.23G/2.67G [00:10<00:12, 120MB/s]'),
    ).toBeUndefined();
    expect(parseTqdm('Loading pipeline components...')).toBeUndefined();
    expect(parseTqdm('')).toBeUndefined();
  });
});
