import { describe, expect, it } from 'vitest';
import {
  detectAccelerators,
  parseLspci,
  parseMacDisplays,
  parseNvidiaSmi,
  parseWindowsVideoControllers,
  rankGpus,
  usableMemoryGB,
  vendorFromName,
} from './accelerator.js';

/**
 * These parsers are the foundation of every later recommendation, so the tests
 * are the cases that would silently poison one: a saturated Windows VRAM field,
 * an iGPU outranking the discrete card beside it, and unified memory being
 * mistaken for a dedicated budget.
 */
describe('nvidia-smi', () => {
  it('reads name, VRAM and compute capability', () => {
    const out = 'NVIDIA GeForce RTX 4090, 24564 MiB, 8.9\nNVIDIA GeForce RTX 3060, 12288 MiB, 8.6';
    expect(parseNvidiaSmi(out)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramGB: 24, cudaMajor: 8 },
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vramGB: 12, cudaMajor: 8 },
    ]);
  });

  it('rounds MiB to the GB a buyer would recognise', () => {
    // 24564 MiB is a 24 GB card. Truncating gives 23 and makes every 24 GB
    // recommendation fail its own fit check.
    expect(parseNvidiaSmi('X, 24564 MiB, 8.9')[0]?.vramGB).toBe(24);
  });

  it('survives an empty or garbled reply', () => {
    expect(parseNvidiaSmi('')).toEqual([]);
    expect(parseNvidiaSmi('\n \n')).toEqual([]);
  });
});

describe('Windows video controllers', () => {
  it('DISCARDS the saturated 32-bit AdapterRAM field', () => {
    // AdapterRAM is 32-bit, so anything above 4 GB reports 4294967295. Believing
    // it tells an RTX 4090 owner they have 4 GB of VRAM.
    const csv = 'Node,AdapterRAM,Name\nPC,4294967295,NVIDIA GeForce RTX 4090';
    const [gpu] = parseWindowsVideoControllers(csv);
    expect(gpu?.name).toBe('NVIDIA GeForce RTX 4090');
    expect(gpu?.vramGB).toBeUndefined();
  });

  it('keeps a believable one', () => {
    const csv = 'Node,AdapterRAM,Name\nPC,2147483648,Intel(R) Iris(R) Xe Graphics';
    expect(parseWindowsVideoControllers(csv)[0]).toEqual({
      vendor: 'intel',
      name: 'Intel(R) Iris(R) Xe Graphics',
      vramGB: 2,
    });
  });
});

describe('macOS displays', () => {
  it('reads the chip and reports NO vram, because there is none', () => {
    // Apple GPUs share system memory. Reporting the system total as VRAM would
    // make a 24 GB Mac look like a 24 GB discrete card, which is a different
    // budget entirely — the OS and the app are in it too.
    const json = JSON.stringify({
      SPDisplaysDataType: [
        {
          _name: 'Apple M5 Pro',
          sppci_model: 'Apple M5 Pro',
          spdisplays_vendor: 'sppci_vendor_Apple',
        },
      ],
    });
    expect(parseMacDisplays(json)).toEqual([{ vendor: 'apple', name: 'Apple M5 Pro' }]);
  });

  it('does not throw on non-JSON', () => {
    expect(parseMacDisplays('not json')).toEqual([]);
  });
});

describe('lspci', () => {
  it('finds the display controllers and nothing else', () => {
    const out = [
      '00:02.0 "VGA compatible controller" "Intel Corporation" "AlderLake-P GT2" -r0c "Dell" "Device 0aff"',
      '01:00.0 "3D controller" "NVIDIA Corporation" "GA106M [GeForce RTX 3060]" -ra1 "Dell" "x"',
      '00:1f.3 "Audio device" "Intel Corporation" "Alder Lake PCH-P" -r01 "Dell" "y"',
    ].join('\n');
    const gpus = parseLspci(out);
    expect(gpus).toHaveLength(2);
    expect(gpus.map((g) => g.vendor)).toEqual(['intel', 'nvidia']);
  });
});

describe('vendor from a marketing name', () => {
  it('recognises the ones that matter', () => {
    expect(vendorFromName('NVIDIA GeForce RTX 4090')).toBe('nvidia');
    expect(vendorFromName('AMD Radeon RX 7900 XTX')).toBe('amd');
    expect(vendorFromName('Intel(R) Arc(TM) A770')).toBe('intel');
    expect(vendorFromName('Apple M5 Pro')).toBe('apple');
    expect(vendorFromName('Some Unknown Adapter')).toBe('unknown');
  });
});

describe('ranking', () => {
  it('puts the discrete card ahead of the iGPU in the same box', () => {
    // A laptop reports both, and picking the wrong one costs an order of
    // magnitude — this is the single most consequential sort in the file.
    const ranked = rankGpus([
      { vendor: 'intel', name: 'Iris Xe' },
      { vendor: 'nvidia', name: 'RTX 4060 Laptop', vramGB: 8 },
    ]);
    expect(ranked[0]?.vendor).toBe('nvidia');
  });
});

describe('the memory a model actually gets', () => {
  const base = {
    platform: 'linux' as const,
    arch: 'x64',
    appleSilicon: false,
    totalRamGB: 64,
    unifiedMemory: false,
    npu: false,
  };

  it('is VRAM on a discrete card, NOT system RAM', () => {
    // Spilling into system RAM is what "it ran, at one token a second" means.
    const info = { ...base, gpus: [{ vendor: 'nvidia' as const, name: 'RTX 3060', vramGB: 12 }] };
    expect(usableMemoryGB(info)).toBe(12);
  });

  it('is most of system RAM on unified memory', () => {
    const info = {
      ...base,
      platform: 'darwin' as const,
      appleSilicon: true,
      unifiedMemory: true,
      totalRamGB: 24,
      gpus: [{ vendor: 'apple' as const, name: 'Apple M5 Pro' }],
    };
    // 75%: the OS and the app live in the same pool, and a recommendation that
    // takes all of it swaps.
    expect(usableMemoryGB(info)).toBe(18);
  });

  it('falls back to system RAM when there is no GPU at all', () => {
    expect(usableMemoryGB({ ...base, gpus: [], totalRamGB: 16 })).toBe(12);
  });
});

describe('detection end to end, with every probe failing', () => {
  it('still produces a usable answer instead of an error', async () => {
    // A container with no lspci, no nvidia-smi and no wmic is a real machine.
    const info = await detectAccelerators({
      run: async () => {
        throw new Error('not found');
      },
      platformOverride: 'linux',
      archOverride: 'x64',
      totalMemBytes: 32 * 1024 ** 3,
    });
    expect(info.platform).toBe('linux');
    expect(info.totalRamGB).toBe(32);
    expect(info.gpus).toEqual([]);
    expect(usableMemoryGB(info)).toBe(24);
  });

  it('reads a real NVIDIA box', async () => {
    const info = await detectAccelerators({
      run: async (cmd) => {
        if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564 MiB, 8.9\n';
        throw new Error('not found');
      },
      platformOverride: 'linux',
      archOverride: 'x64',
      totalMemBytes: 64 * 1024 ** 3,
    });
    expect(info.gpus[0]?.vramGB).toBe(24);
    expect(info.unifiedMemory).toBe(false);
    expect(usableMemoryGB(info)).toBe(24);
  });
});
