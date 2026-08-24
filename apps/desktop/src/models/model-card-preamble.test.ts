import { describe, expect, it } from 'vitest';
import { trimCardPreamble } from './ModelCard';

/**
 * The detail pane is where someone goes to decide whether to spend 17 GB of
 * disk. What it must not open with is somebody else's advertisement.
 */
describe('trimming a model card preamble', () => {
  it('drops a banner for a DIFFERENT model', () => {
    // Verbatim from stabilityai/TripoSR, which is what put this test here.
    const md = [
      'Try our new model: **SF3D** with several improvements such as faster generation and more game-ready assets.',
      'The model is available [here](https://x) and we also have a [demo](https://y).',
      '# TripoSR',
      'TripoSR is a fast and feed-forward 3D generative model…',
    ].join('\n\n');
    const out = trimCardPreamble(md);
    expect(out.startsWith('# TripoSR')).toBe(true);
    expect(out).not.toContain('SF3D');
  });

  it('drops a row of shields.io badges', () => {
    const md = '[![License](https://img.shields.io/a.svg)](https://l)\n\n# Thing\n\nreal text';
    expect(trimCardPreamble(md).startsWith('# Thing')).toBe(true);
  });

  it('KEEPS a plain lead paragraph, which is usually the only description', () => {
    const md = 'Kokoro is an open-weight TTS model with 82 million parameters.\n\n## Usage\n\n…';
    expect(trimCardPreamble(md).startsWith('Kokoro is an open-weight')).toBe(true);
  });

  it('never cuts past the first heading', () => {
    const md = '# Model\n\nTry our new model: something else entirely.';
    expect(trimCardPreamble(md)).toBe(md);
  });

  it('returns the original when the card is nothing BUT a banner', () => {
    // An odd first line still beats an empty pane.
    const md = 'Announcing: the weights move to another repo.';
    expect(trimCardPreamble(md)).toBe(md);
  });
});

describe('the real card that put this here', () => {
  // Verbatim from stabilityai/TripoSR, blank-ish line and all. The space on the
  // line between the banner and the heading is load-bearing: it is what made
  // the first attempt eat the whole card.
  const REAL = [
    '> Try our new model: **SF3D** with several improvements such as faster generation and more game-ready assets.',
    '> ',
    '> The model is available [here](https://huggingface.co/stabilityai/stable-fast-3d) and we also have a [demo](https://huggingface.co/spaces/stabilityai/stable-fast-3d).',
    ' ',
    '# TripoSR',
    '![](figures/input800.mp4)',
    'TripoSR is a fast and feed-forward 3D generative model developed in collaboration between Stability AI and Tripo AI.',
  ].join('\n');

  it('drops the banner and KEEPS the model it is describing', () => {
    const out = trimCardPreamble(REAL);
    expect(out).not.toContain('SF3D');
    expect(out.startsWith('# TripoSR')).toBe(true);
    expect(out).toContain('feed-forward 3D generative model');
  });
});
