import { describe, expect, it } from 'vitest';
import { formatOfRepo, type PickerHost, pickEngine, summarisePick } from './engine-picker';

/**
 * The tests are the situations where a plausible implementation quietly picks
 * something that cannot run — which is the only failure mode that matters here,
 * because a wrong recommendation costs a multi-gigabyte download and a crash.
 */
const mac: PickerHost = {
  platform: 'darwin',
  appleSilicon: true,
  gpuVendor: 'apple',
  npu: true,
  usableMemoryGB: 18,
};
const rtx4090: PickerHost = {
  platform: 'win32',
  appleSilicon: false,
  gpuVendor: 'nvidia',
  cudaMajor: 8,
  npu: false,
  usableMemoryGB: 24,
};
const gtx1080: PickerHost = {
  platform: 'win32',
  appleSilicon: false,
  gpuVendor: 'nvidia',
  cudaMajor: 6,
  npu: false,
  usableMemoryGB: 8,
};
const radeonLinux: PickerHost = {
  platform: 'linux',
  appleSilicon: false,
  gpuVendor: 'amd',
  npu: false,
  usableMemoryGB: 16,
};

describe('reading the format off a repo', () => {
  it('believes the FILES over the name', () => {
    // A repo called `…-GGUF` that publishes safetensors is telling you what it
    // is in the only way that matters.
    expect(formatOfRepo('someone/Model-GGUF', ['model.safetensors'])).toBe('safetensors');
    expect(formatOfRepo('someone/Model', ['model-Q4_K_M.gguf'])).toBe('gguf');
  });

  it('falls back to the name when the files are not listed yet', () => {
    expect(formatOfRepo('unsloth/Qwen3.8-27B-GGUF')).toBe('gguf');
    expect(formatOfRepo('mlx-community/Qwen3.5-4B-MLX-4bit')).toBe('mlx');
    expect(formatOfRepo('turboderp/Model-exl3')).toBe('exl3');
    expect(formatOfRepo('black-forest-labs/FLUX.2-klein-4B')).toBe('safetensors');
  });

  it('reads an mlx repo by its org even when it ships safetensors', () => {
    expect(formatOfRepo('mlx-community/Whatever', ['weights.safetensors'])).toBe('mlx');
  });
});

describe('a GGUF text model', () => {
  const gguf = { repo: 'unsloth/Qwen3.8-27B-GGUF', modality: 'text' as const, format: 'gguf' as const };

  it('runs on llama.cpp everywhere, including a machine with no GPU at all', () => {
    const cpuOnly: PickerHost = {
      platform: 'linux',
      appleSilicon: false,
      gpuVendor: 'unknown',
      npu: false,
      usableMemoryGB: 12,
    };
    expect(pickEngine(gguf, cpuOnly).best?.spec.id).toBe('llamacpp');
  });

  it('never suggests vLLM for it — vLLM does not load GGUF', () => {
    // The most common category error in this space: ranking by speed across
    // engines that cannot open the file.
    const pick = pickEngine(gguf, rtx4090);
    expect(pick.ranked.map((c) => c.spec.id)).not.toContain('vllm');
    expect(pick.rejected.find((r) => r.spec.id === 'vllm')?.blocker).toMatch(/does not load gguf/);
  });

  it('rejects an MLX engine for a GGUF on the FORMAT, before the platform', () => {
    // Both are true — rapid-mlx is macOS-only AND cannot load GGUF — and the
    // order is deliberate: the file is the more useful reason, because it holds
    // even for the Mac user who would otherwise think the engine was an option.
    expect(pickEngine(gguf, rtx4090).rejected.find((r) => r.spec.id === 'rapid-mlx')?.blocker).toBe(
      'does not load gguf weights',
    );
    expect(pickEngine(gguf, mac).rejected.find((r) => r.spec.id === 'rapid-mlx')?.blocker).toBe(
      'does not load gguf weights',
    );
  });

  it('names the platform when the format is not the problem', () => {
    const mlxOnWindows = {
      repo: 'mlx-community/X',
      modality: 'text' as const,
      format: 'mlx' as const,
    };
    expect(
      pickEngine(mlxOnWindows, rtx4090).rejected.find((r) => r.spec.id === 'rapid-mlx')?.blocker,
    ).toMatch(/macOS only/);
  });
});

describe('an MLX model', () => {
  const mlx = {
    repo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    modality: 'text' as const,
    format: 'mlx' as const,
  };

  it('picks the Apple path on a Mac', () => {
    expect(pickEngine(mlx, mac).best?.spec.id).toBe('dflash-mlx');
  });

  it('has NOTHING that can run it on a PC, and says so per engine', () => {
    const pick = pickEngine(mlx, rtx4090);
    expect(pick.best).toBeUndefined();
    expect(pick.ranked).toHaveLength(0);
    // Every rejection names a fact about the machine or the file.
    expect(pick.rejected.every((r) => r.blocker.length > 0)).toBe(true);
    expect(summarisePick(pick)).toBeUndefined();
  });
});

describe('CUDA generations', () => {
  const safetensors = {
    repo: 'black-forest-labs/FLUX.2-klein-4B',
    modality: 'image' as const,
    format: 'safetensors' as const,
  };

  it('offers Nunchaku on an RTX 4090', () => {
    expect(pickEngine(safetensors, rtx4090).bestPossible?.spec.id).toBe('nunchaku');
  });

  it('does NOT offer it on a GTX 1080, and names the generation not the number', () => {
    // "compute capability 7.0" is not something most people know about their own
    // card; "RTX 20-series or newer" is.
    const blocker = pickEngine(safetensors, gtx1080).rejected.find(
      (r) => r.spec.id === 'nunchaku',
    )?.blocker;
    expect(blocker).toBe('needs RTX 20-series or newer');
  });

  it('leaves an AMD box on the portable engine', () => {
    const pick = pickEngine(safetensors, radeonLinux);
    expect(pick.best?.spec.id).toBe('comfyui');
    expect(pick.rejected.find((r) => r.spec.id === 'nunchaku')?.blocker).toMatch(/nvidia/i);
  });
});

describe('wired versus catalogued', () => {
  const safetensors = {
    repo: 'black-forest-labs/FLUX.2-klein-4B',
    modality: 'image' as const,
    format: 'safetensors' as const,
  };

  it('never routes a job to an engine we have not integrated', () => {
    // The catalogue runs ahead of the wiring on purpose. `best` must always be
    // something we can actually drive.
    const pick = pickEngine(safetensors, rtx4090);
    expect(pick.best?.spec.wired).toBe(true);
    expect(pick.bestPossible?.spec.id).toBe('nunchaku');
    expect(pick.bestPossible?.spec.wired).not.toBe(true);
  });

  it('says what is being left on the table', () => {
    const line = summarisePick(pickEngine(safetensors, rtx4090));
    expect(line).toMatch(/ComfyUI/);
    expect(line).toMatch(/Nunchaku would be faster/);
  });
});

describe('what is already installed', () => {
  const gguf = {
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    modality: 'text' as const,
    format: 'gguf' as const,
  };

  it('breaks a near tie toward the engine already on disk', () => {
    // A 200 MB download that starts now beats a 4 GB one that is 12% quicker
    // afterwards.
    const withIk = pickEngine(gguf, rtx4090, ['ik-llama']);
    expect(withIk.ranked[0]?.spec.id).toBe('ik-llama');
    expect(withIk.ranked[0]?.reason).toMatch(/already installed/);
  });

  it('does NOT let an installed engine beat a genuinely faster tier', () => {
    // +5 clears one rank tier (they are 10 apart), never two — otherwise the
    // first engine a user installs becomes permanent.
    const mlxModel = { repo: 'mlx-community/X', modality: 'text' as const, format: 'mlx' as const };
    const pick = pickEngine(mlxModel, mac, ['rapid-mlx']);
    expect(pick.ranked[0]?.spec.id).toBe('dflash-mlx');
  });
});
