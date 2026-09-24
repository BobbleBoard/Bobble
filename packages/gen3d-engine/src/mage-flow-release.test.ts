import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GEN3D_MODEL_SPECS,
  type Gen3dModelSpec,
  specTotalBytes,
  toSidecarRegistry,
} from './catalog';
import {
  MAGE_FLOW_COMFY_REPO,
  MAGE_FLOW_CONFIGS,
  MAGE_FLOW_SHA256,
  MAGE_FLOW_TEXT_ENCODER_REPO,
} from './mage-flow-release';

/** Git's id for a file's bytes: sha1("blob <len>\0" + bytes) — what the hub
 * lists as a small file's oid. */
function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function spec(id: 'mageflow' | 'mageflow-edit'): Gen3dModelSpec {
  const s = GEN3D_MODEL_SPECS.find((m) => m.id === id);
  if (s === undefined) throw new Error(`no ${id}`);
  return s;
}

const MAGE = [spec('mageflow'), spec('mageflow-edit')];

describe('Mage-Flow source (the withdrawn microsoft/* release, rebuilt)', () => {
  it('writes the release configs byte for byte (git blob ids of the original trees)', () => {
    // From the trees saved when the user's copies were downloaded:
    // microsoft/Mage-Flow-Turbo @ 34f3a2d2 and microsoft/Mage-Flow-Edit-Turbo
    // @ 14427bd7 carry identical copies of all four.
    expect(
      Object.fromEntries(Object.entries(MAGE_FLOW_CONFIGS).map(([p, t]) => [p, gitBlobId(t)])),
    ).toEqual({
      'model_index.json': '7bff2b06ec6b2d24d3dd9f9a2c5ef979bb906835',
      'scheduler/scheduler_config.json': 'aa6f43e3bbcd205db53672cd7ea3551abc45609e',
      'transformer/config.json': '4daa97cf70326fddcdb2a87af70a63e79315d477',
      'vae/config.json': 'bd9d3a47ebcde47ee85f118f204601098e7b856d',
    });
  });

  it('never downloads from microsoft/*, and honours those repos only on disk', () => {
    for (const s of MAGE) {
      expect(s.repos.map((r) => r.repo)).toEqual([
        MAGE_FLOW_COMFY_REPO,
        MAGE_FLOW_TEXT_ENCODER_REPO,
      ]);
      expect(s.repos.some((r) => r.repo.startsWith('microsoft/'))).toBe(false);
    }
    expect(spec('mageflow').legacyRepos?.map((r) => r.repo)).toEqual(['microsoft/Mage-Flow-Turbo']);
    expect(spec('mageflow-edit').legacyRepos?.map((r) => r.repo)).toEqual([
      'microsoft/Mage-Flow-Edit-Turbo',
    ]);
  });

  it('assembles every large file from a pinned file with the release sha256', () => {
    for (const s of MAGE) {
      const legacy = s.legacyRepos?.[0];
      expect(legacy).toBeDefined();
      const legacyPins = new Map((legacy?.pinned ?? []).map((f) => [f.path, f]));
      for (const entry of s.layout ?? []) {
        if (entry.kind === 'text') continue;
        const repo = s.repos.find((r) => r.repo === entry.repo);
        expect(
          repo,
          `${s.id}: ${entry.path} names a repo the model does not download`,
        ).toBeDefined();
        if (entry.kind === 'file') {
          // Downloaded (named by the patterns) and pinned — and the pin is the
          // release's own file at that path.
          expect(repo?.allowPatterns).toContain(entry.source);
          const pin = repo?.pinned?.find((f) => f.path === entry.source);
          expect(pin, `${s.id}: ${entry.source} is not pinned`).toBeDefined();
          expect(pin?.sha256).toBe(legacyPins.get(entry.path)?.sha256);
          expect(pin?.bytes).toBe(legacyPins.get(entry.path)?.bytes);
        } else {
          // text_encoder/: every pinned shard is the release's text_encoder shard.
          for (const pin of repo?.pinned ?? []) {
            expect(pin.sha256).toBe(legacyPins.get(`${entry.path}/${pin.path}`)?.sha256);
          }
          expect(repo?.pinned?.length).toBe(2);
        }
      }
    }
    expect(spec('mageflow').repos[0]?.pinned?.[0]?.sha256).toBe(MAGE_FLOW_SHA256.turboTransformer);
    expect(spec('mageflow-edit').repos[0]?.pinned?.[0]?.sha256).toBe(
      MAGE_FLOW_SHA256.editTurboTransformer,
    );
  });

  it('lays out everything both engines open', () => {
    // mflux's Mage-Flow port requires this "official" set
    // (MageFlowWeightDefinition.get_required_download_pattern_groups), and the
    // PyTorch MageFlowPipeline reads the same files plus scheduler/.
    for (const s of MAGE) {
      const paths = (s.layout ?? []).map((e) => e.path).sort();
      expect(paths).toEqual([
        'model_index.json',
        'scheduler/scheduler_config.json',
        'text_encoder',
        'transformer/config.json',
        'transformer/diffusion_pytorch_model.safetensors',
        'vae/config.json',
        'vae/diffusion_pytorch_model.safetensors',
      ]);
    }
    const index = JSON.parse(MAGE_FLOW_CONFIGS['model_index.json'] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(index._vae_source).toBe('vae/diffusion_pytorch_model.safetensors');
    expect(index._text_encoder_path).toBe('text_encoder');
  });

  it('shares the text encoder with CubePart and the text encoder + VAE between the two', () => {
    const cube = GEN3D_MODEL_SPECS.find((m) => m.id === 'cubepart');
    const cubeQwen = cube?.repos.find((r) => r.repo === MAGE_FLOW_TEXT_ENCODER_REPO);
    const mageQwen = spec('mageflow').repos[1];
    // Same repo, same patterns, same bytes: one download serves both.
    expect(mageQwen?.allowPatterns).toEqual(cubeQwen?.allowPatterns);
    expect(mageQwen?.bytes).toBe(cubeQwen?.bytes);

    for (const s of MAGE) expect(specTotalBytes(s)).toBe(17_463_873_896);
    const pinnedBytes = (s: Gen3dModelSpec) =>
      new Map(
        s.repos.flatMap((r) => (r.pinned ?? []).map((f) => [`${r.repo}:${f.path}`, f.bytes])),
      );
    const gen = pinnedBytes(spec('mageflow'));
    const edit = pinnedBytes(spec('mageflow-edit'));
    const shared = [...edit].filter(([k]) => gen.has(k)).reduce((n, [, b]) => n + b, 0);
    // The VAE and both encoder shards: what the editor does NOT download again
    // beside the generator (the encoder's small json/txt files aside).
    expect(shared).toBe(345_053_056 + 4_967_229_296 + 3_908_490_048);
    expect(specTotalBytes(spec('mageflow-edit')) - shared).toBeLessThan(8_300_000_000);
  });

  it('changes nothing the 3D studio download card shows', () => {
    // The card renders label, note and formatGb(sizeBytes) (tripo/gen-ui.tsx):
    // the source moved, the card did not.
    expect(spec('mageflow').label).toBe('Mage-Flow Turbo');
    expect(spec('mageflow').note).toBe(
      'Text → image in 4 steps, the first hop of text → 3D (microsoft/Mage-Flow-Turbo, MIT)',
    );
    expect(spec('mageflow-edit').label).toBe('Mage-Flow Edit');
    expect(spec('mageflow-edit').note).toBe(
      'Edit a generated image from an instruction before turning it into 3D (9s per edit on MLX)',
    );
    for (const s of MAGE) expect(`${(specTotalBytes(s) / 1e9).toFixed(1)} GB`).toBe('17.5 GB');
  });

  it('keeps the legacy byte total the old catalog measured for these patterns', () => {
    for (const s of MAGE) expect(s.legacyRepos?.[0]?.bytes).toBe(17_463_884_035);
  });

  it('is exactly what the Python tests drive the sidecar with', () => {
    // python/tests/test_mage_flow_source.py builds a fake hub cache from this
    // fixture, so the field names the sidecar reads (pinned, sha256, layout,
    // kind, source, legacyRepos) are the ones this catalog writes. Regenerate
    // with UPDATE_FIXTURES=1 after a deliberate catalog change.
    const fixture = fileURLToPath(
      new URL('../python/tests/fixtures/mage-flow-registry.json', import.meta.url),
    );
    const current = {
      models: toSidecarRegistry().models.filter((m) => m.id.startsWith('mageflow')),
    };
    if (process.env.UPDATE_FIXTURES === '1') {
      writeFileSync(fixture, `${JSON.stringify(current, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(fixture, 'utf8'))).toEqual(current);
  });
});
