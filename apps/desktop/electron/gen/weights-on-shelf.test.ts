import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getModel, type ModalityModel } from '@pi-desktop/gen-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PREPARED_COMPONENTS,
  preparedDir,
  preparedPresent,
  weightsMeta,
  weightsPresent,
} from './weights-on-shelf';

/**
 * A model MADE on this Mac (mflux.prepared — Qwen-Image 2.1): where its
 * folder is, when it counts as there, and what the button says it costs.
 * The library root is a temp dir through PI_DESKTOP_MODELS_DIR, the same
 * override the app itself honours.
 */
describe('prepared weights on the shelf', () => {
  let library: string;
  let saved: string | undefined;
  const qwen = getModel('qwen-image-2.1') as ModalityModel;

  beforeEach(() => {
    library = mkdtempSync(path.join(tmpdir(), 'bobble-library-'));
    saved = process.env.PI_DESKTOP_MODELS_DIR;
    process.env.PI_DESKTOP_MODELS_DIR = library;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PI_DESKTOP_MODELS_DIR;
    else process.env.PI_DESKTOP_MODELS_DIR = saved;
    rmSync(library, { recursive: true, force: true });
  });

  it('lives in its own folder on the Image/Generation shelf, named by the catalog', () => {
    expect(preparedDir(qwen)).toBe(
      path.join(library, 'Image', 'Generation', 'qwen-image-2.1-mflux-4bit-te8'),
    );
    // Not a repo entry: a conversion has no <org__repo> of its own.
    expect(preparedDir(qwen)).not.toContain('qwen__');
  });

  it('counts as present only when every component mflux writes is there, plus the tokenizer', () => {
    const dir = preparedDir(qwen);
    expect(preparedPresent(qwen)).toBe(false);
    expect(weightsPresent(qwen)).toBe(false);
    // An interrupted save: the transformer landed, the rest did not.
    mkdirSync(path.join(dir, 'transformer'), { recursive: true });
    writeFileSync(path.join(dir, 'transformer', '0.safetensors'), '');
    writeFileSync(path.join(dir, 'transformer', 'model.safetensors.index.json'), '{}');
    expect(preparedPresent(qwen)).toBe(false);
    for (const c of PREPARED_COMPONENTS) {
      mkdirSync(path.join(dir, c), { recursive: true });
      writeFileSync(path.join(dir, c, '0.safetensors'), '');
      writeFileSync(path.join(dir, c, 'model.safetensors.index.json'), '{}');
    }
    expect(preparedPresent(qwen)).toBe(false);
    mkdirSync(path.join(dir, 'processor'), { recursive: true });
    writeFileSync(path.join(dir, 'processor', 'tokenizer.json'), '{}');
    expect(preparedPresent(qwen)).toBe(true);
    // The weights gate reads the conversion for such a model, not a file list.
    expect(weightsPresent(qwen)).toBe(true);
  });

  it('says what the button fetches and what stays', () => {
    const meta = weightsMeta(qwen);
    expect(meta.label).toBe('Qwen-Image 2.1 weights');
    expect(meta.approxGB).toBe(31);
    expect(meta.blurb).toContain('31 GB');
    expect(meta.blurb).toContain('13 GB');
    expect(meta.blurb).toContain('4-bit');
    expect(meta.noun).toBe('Qwen-Image 2.1');
  });

  it('a model that prepares nothing throws rather than inventing a folder', () => {
    const klein = getModel('flux2-klein-4b') as ModalityModel;
    expect(() => preparedDir(klein)).toThrow(/prepares no weights/);
    expect(preparedPresent(klein)).toBe(false);
  });
});
