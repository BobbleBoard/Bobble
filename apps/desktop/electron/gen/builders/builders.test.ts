import type { GenJob, ModalityModel } from '@pi-desktop/gen-service';
import { afterEach, describe, expect, it } from 'vitest';
import {
  builderFor,
  GEN_JOB_BUILDERS,
  type GenJobBuilder,
  genJobBuilders,
  registerGenJobBuilder,
} from './index';

const model = { id: 'ming-design', modality: 'image' } as unknown as ModalityModel;
const other = { id: 'z-image-turbo', modality: 'image' } as unknown as ModalityModel;

const ming: GenJobBuilder = {
  id: 'mlx-vlm-design',
  modality: 'image',
  handles: (m) => m.id === 'ming-design',
  build: (_m, _p, ctx) => ({ id: ctx.jobId, outputDir: ctx.outputDir }) as unknown as GenJob,
};

describe('gen job builders (the W0 registry)', () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  it('ships empty: nothing is routed through it until GEN-SEAM', () => {
    expect(GEN_JOB_BUILDERS).toEqual([]);
    expect(genJobBuilders()).toEqual([]);
    expect(builderFor(model)).toBeUndefined();
  });

  it('finds a registered builder by the entry it handles, and by modality', () => {
    off = registerGenJobBuilder(ming);
    expect(builderFor(model)).toBe(ming);
    expect(builderFor(model, 'image')).toBe(ming);
    expect(builderFor(model, 'video')).toBeUndefined();
    expect(builderFor(other)).toBeUndefined();
    const job = ming.build(model, {}, { jobId: 'j1', outputDir: '/tmp/out' });
    expect(job).toMatchObject({ id: 'j1' });
  });

  it('unregisters', () => {
    off = registerGenJobBuilder(ming);
    off();
    expect(builderFor(model)).toBeUndefined();
  });
});
