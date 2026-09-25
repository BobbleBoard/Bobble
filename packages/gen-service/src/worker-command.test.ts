import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend } from './protocol.ts';
import {
  backendUvFlags,
  baseWorkerWith,
  buildEnvWarmArgs,
  buildMfluxSaveArgs,
  buildWorkerUvArgs,
  bundledMlxVlmWheel,
  bundledWheelPath,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
  MLX_AUDIO_PIN,
  MLX_VLM_COMMIT,
  MLX_VLM_RESOLVED_BEFORE,
  MLX_VLM_WHEEL,
  mfluxSaveUvEnv,
  resolveWorkerScript,
  warmUvEnv,
  workerUvEnv,
} from './worker-command.ts';

/** packages/gen-service/python — worker.py, wheels/, mlx-vlm-ming/. */
const PYTHON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'python');

describe('buildWorkerUvArgs', () => {
  it('builds `uv run --with mflux==<pin> python <worker>` by default', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py' });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      `mflux==${MFLUX_PIN}`,
      'python',
      '/w/worker.py',
    ]);
  });

  it('pins mflux + python explicitly when asked', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      mfluxPin: '9.9.9',
      python: '3.13',
    });
    expect(args).toContain('mflux==9.9.9');
    expect(args[args.indexOf('--python') + 1]).toBe('3.13');
  });

  it('runs a model on its own bundled mflux build in place of the pin (Qwen-Image 2.1)', () => {
    // The wheel beside worker.py, in the checkout and the packaged app alike.
    const wheel = bundledWheelPath(
      '/w/worker.py',
      'mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl',
    );
    expect(wheel).toBe(
      path.join('/w', 'wheels', 'mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl'),
    );
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', mfluxWith: wheel });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      wheel,
      'python',
      '/w/worker.py',
    ]);
    // Never both: the pinned release and the wheel are the same package.
    expect(args.filter((a) => a.startsWith('mflux=='))).toEqual([]);
    // The env warm takes the same override, so the module can warm that env too.
    expect(buildEnvWarmArgs({ backend: 'mflux', mfluxWith: wheel })).toContain(wheel);
    expect(buildEnvWarmArgs({ backend: 'mflux' })).toContain(`mflux==${MFLUX_PIN}`);
    // An empty override means the pin.
    expect(buildWorkerUvArgs({ workerScript: '/w/worker.py', mfluxWith: '' })).toContain(
      `mflux==${MFLUX_PIN}`,
    );
  });

  it('appends extra --with deps (a future modality backend) before python', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      extraWith: ['mlx-audio', 'soundfile'],
    });
    // Order: base mflux --with, then each extra --with, then `python <script>`.
    expect(args.slice(-6)).toEqual([
      '--with',
      'mlx-audio',
      '--with',
      'soundfile',
      'python',
      '/w/worker.py',
    ]);
  });

  it('uses the mlx-audio base for a TTS backend and does NOT force mflux', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'mlx-audio' });
    expect(args).toContain(`mlx-audio==${MLX_AUDIO_PIN}`);
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      `mlx-audio==${MLX_AUDIO_PIN}`,
    ]);
  });

  it('uses the 3D deps for triposr/trellis without dragging in mflux', () => {
    const triposr = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'triposr' });
    expect(triposr.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(triposr).toContain('torch');

    const trellis = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'trellis' });
    expect(trellis.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(trellis).toContain('trellis2-mlx');
  });

  it('keeps extraWith additive on a non-mflux backend (still no mflux)', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'mlx-audio',
      extraWith: ['soundfile'],
    });
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args.slice(-4)).toEqual(['--with', 'soundfile', 'python', '/w/worker.py']);
  });

  it('appends --serve AFTER the worker script for the persistent 3D path', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'trellis',
      serveMode: true,
    });
    // `--serve` is a worker.py flag, so it must come after `python <script>`.
    expect(args.slice(-3)).toEqual(['python', '/w/worker.py', '--serve']);
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args).toContain('trellis2-mlx');
  });

  it('omits --serve by default (process-per-job, unchanged)', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py' });
    expect(args).not.toContain('--serve');
    expect(args.slice(-2)).toEqual(['python', '/w/worker.py']);
  });

  it('adds no base --with for server/Node backends (not uv-worker driven)', () => {
    for (const backend of ['comfyui', 'hyperframes'] as const) {
      const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend });
      expect(args).toEqual([
        'run',
        '--no-project',
        '--python',
        DEFAULT_PYTHON_VERSION,
        'python',
        '/w/worker.py',
      ]);
    }
  });
});

describe('offline launches (the probe decides — uv-run.ts)', () => {
  const QWEN = bundledWheelPath('/w/worker.py', 'mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl');
  const JOBS = [
    { workerScript: '/w/worker.py' },
    { workerScript: '/w/worker.py', mfluxWith: QWEN },
    { workerScript: '/w/worker.py', backend: 'mlx-audio' as const, extraWith: ['misaki[en]'] },
    { workerScript: '/w/worker.py', backend: 'mlx-vlm' as const },
    { workerScript: '/w/worker.py', backend: 'trellis' as const, serveMode: true },
  ];

  it('a job launches offline as the same argv with --offline straight after `run`', () => {
    for (const job of JOBS) {
      const online = buildWorkerUvArgs(job);
      expect(online).not.toContain('--offline');
      expect(buildWorkerUvArgs({ ...job, offline: false })).toEqual(online);
      expect(buildWorkerUvArgs({ ...job, offline: true })).toEqual([
        'run',
        '--offline',
        ...online.slice(1),
      ]);
    }
  });

  it('workerUvEnv is exactly what the job launches in (between `run` and python)', () => {
    for (const job of JOBS) {
      const args = buildWorkerUvArgs(job);
      expect(workerUvEnv(job)).toEqual(args.slice(1, args.indexOf('python')));
    }
  });

  it('the warm launches offline the same way, and warms the env the job runs in', () => {
    const warms = [
      { backend: 'mflux' as const },
      { backend: 'mflux' as const, mfluxWith: QWEN },
      { backend: 'mlx-audio' as const },
      { backend: 'mlx-vlm' as const, workerScript: '/w/worker.py' },
    ];
    for (const warm of warms) {
      const online = buildEnvWarmArgs(warm);
      expect(buildEnvWarmArgs({ ...warm, offline: true })).toEqual([
        'run',
        '--offline',
        ...online.slice(1),
      ]);
      expect(warmUvEnv(warm)).toEqual(online.slice(1, online.indexOf('python')));
      expect(warmUvEnv(warm)).toEqual(workerUvEnv({ workerScript: '/w/worker.py', ...warm }));
    }
  });
});

describe('buildMfluxSaveArgs (a model converted on this Mac)', () => {
  const QWEN = bundledWheelPath('/w/worker.py', 'mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl');

  it('runs mflux-save from the model’s own wheel — the argv gen-modules always built', () => {
    expect(
      buildMfluxSaveArgs({ mfluxWith: QWEN, model: '/store/release', bits: 4, dest: '/shelf/q4' }),
    ).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      QWEN,
      'mflux-save',
      '--model',
      '/store/release',
      '-q',
      '4',
      '--path',
      '/shelf/q4',
    ]);
  });

  it('names a base model only when given, and falls back to PyPI mflux without a wheel', () => {
    const args = buildMfluxSaveArgs({
      model: '/r',
      baseModel: 'qwen-image',
      bits: 8,
      dest: '/d',
    });
    expect(args.slice(4, 6)).toEqual(['--with', 'mflux']);
    expect(args.slice(args.indexOf('--base-model'), args.indexOf('--base-model') + 2)).toEqual([
      '--base-model',
      'qwen-image',
    ]);
    expect(buildMfluxSaveArgs({ model: '/r', bits: 8, dest: '/d' })).not.toContain('--base-model');
    expect(mfluxSaveUvEnv({ mfluxWith: '' })).toEqual(mfluxSaveUvEnv({}));
  });

  it('launches offline as the same argv with --offline, in the env its probe asks about', () => {
    const opts = { mfluxWith: QWEN, model: '/r', bits: 4, dest: '/d' };
    const online = buildMfluxSaveArgs(opts);
    expect(buildMfluxSaveArgs({ ...opts, offline: true })).toEqual([
      'run',
      '--offline',
      ...online.slice(1),
    ]);
    expect(mfluxSaveUvEnv(opts)).toEqual(online.slice(1, online.indexOf('mflux-save')));
  });
});

describe('baseWorkerWith', () => {
  it('maps each uv-worker backend to its base package(s)', () => {
    expect(baseWorkerWith('mflux')).toEqual([`mflux==${MFLUX_PIN}`]);
    expect(baseWorkerWith('mflux', '9.9.9')).toEqual(['mflux==9.9.9']);
    expect(baseWorkerWith('mlx-audio')).toEqual([`mlx-audio==${MLX_AUDIO_PIN}`]);
    expect(baseWorkerWith('triposr')).toContain('torch');
    expect(baseWorkerWith('trellis')).toContain('trellis2-mlx');
  });

  it('pins mlx-audio at 0.4.5 (correction #5: the Qwen3-TTS/MOSS/Voxtral release)', () => {
    expect(MLX_AUDIO_PIN).toBe('0.4.5');
    expect(baseWorkerWith('mlx-audio')).toEqual(['mlx-audio==0.4.5']);
  });

  it('pins TripoSR transformers to 4.35.0 (correction #4)', () => {
    expect(baseWorkerWith('triposr')).toContain('transformers==4.35.0');
    // The un-pinned bare `transformers` must NOT be requested.
    expect(baseWorkerWith('triposr')).not.toContain('transformers');
  });

  it('maps the new torch-tts backend (Chatterbox) to its torch base, not mlx-audio', () => {
    const base = baseWorkerWith('torch-tts');
    expect(base).toContain('chatterbox-tts');
    expect(base.some((p) => p.startsWith('mlx-audio'))).toBe(false);
  });

  it('returns no base package for the persistent-server / Node backends', () => {
    expect(baseWorkerWith('comfyui')).toEqual([]);
    expect(baseWorkerWith('hyperframes')).toEqual([]);
  });
});

describe('resolveWorkerScript', () => {
  const prev = process.env[GEN_WORKER_PATH_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[GEN_WORKER_PATH_ENV];
    else process.env[GEN_WORKER_PATH_ENV] = prev;
  });

  it('honours an explicit override first', () => {
    expect(resolveWorkerScript('/explicit/worker.py')).toBe('/explicit/worker.py');
  });

  it('falls back to the env var', () => {
    delete process.env[GEN_WORKER_PATH_ENV];
    process.env[GEN_WORKER_PATH_ENV] = '/env/worker.py';
    expect(resolveWorkerScript()).toBe('/env/worker.py');
  });

  it('defaults to the bundled python/worker.py inside the package', () => {
    delete process.env[GEN_WORKER_PATH_ENV];
    const resolved = resolveWorkerScript();
    expect(resolved.endsWith(path.join('python', 'worker.py'))).toBe(true);
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe('the mlx-vlm design env (Ming-Image)', () => {
  const FROZEN = ['--no-build', '--exclude-newer', MLX_VLM_RESOLVED_BEFORE];

  it('runs the bundled wheel beside worker.py, frozen and never built from source', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'mlx-vlm' });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      ...FROZEN,
      '--with',
      path.join('/w', 'wheels', MLX_VLM_WHEEL),
      'python',
      '/w/worker.py',
    ]);
    // Never PyPI's mlx-vlm (0.7.2 has no Ming), never mflux.
    expect(args.some((a) => a.startsWith('mlx-vlm') || a.startsWith('mlx_vlm=='))).toBe(false);
    expect(args.some((a) => a.startsWith('mflux'))).toBe(false);
  });

  it('takes the wheel from the worker.py it launches (the packaged app’s Resources)', () => {
    const packaged = '/Applications/Bobble.app/Contents/Resources/gen-worker/worker.py';
    const args = buildWorkerUvArgs({ workerScript: packaged, backend: 'mlx-vlm' });
    const wheel = args[args.indexOf('--with') + 1];
    expect(wheel).toBe(bundledMlxVlmWheel(packaged));
    expect(wheel).toBe(
      path.join('/Applications/Bobble.app/Contents/Resources/gen-worker/wheels', MLX_VLM_WHEEL),
    );
  });

  it('honours an explicit wheel path; an empty one means the bundled wheel', () => {
    const explicit = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'mlx-vlm',
      mlxVlmWith: '/elsewhere/mlx_vlm-x.whl',
    });
    expect(explicit).toContain('/elsewhere/mlx_vlm-x.whl');
    expect(explicit).not.toContain(path.join('/w', 'wheels', MLX_VLM_WHEEL));
    const empty = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'mlx-vlm',
      mlxVlmWith: '',
    });
    expect(empty).toContain(path.join('/w', 'wheels', MLX_VLM_WHEEL));
  });

  it('keeps extraWith additive and --serve last', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'mlx-vlm',
      extraWith: ['soundfile'],
      serveMode: true,
    });
    expect(args.slice(-7)).toEqual([
      '--with',
      path.join('/w', 'wheels', MLX_VLM_WHEEL),
      '--with',
      'soundfile',
      'python',
      '/w/worker.py',
      '--serve',
    ]);
  });

  it('warms exactly the env the jobs run in (same flags, same wheel)', () => {
    const job = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'mlx-vlm' });
    const warm = buildEnvWarmArgs({ backend: 'mlx-vlm', workerScript: '/w/worker.py' });
    // Everything before the command is the env: uv resolves one env for both.
    expect(warm.slice(0, warm.indexOf('python'))).toEqual(job.slice(0, job.indexOf('python')));
    expect(warm.slice(-3)).toEqual(['python', '-c', "print('module ready')"]);
    // Handing it the wheel's path directly is the same env.
    expect(
      buildEnvWarmArgs({
        backend: 'mlx-vlm',
        mlxVlmWith: bundledMlxVlmWheel('/w/worker.py'),
      }),
    ).toEqual(warm);
  });

  it('refuses to guess the wheel’s path', () => {
    // Inside the bundled Electron main the package's own path is wrong
    // (gen-manager), so no path is an error, not a quiet default.
    expect(() => baseWorkerWith('mlx-vlm')).toThrow(MLX_VLM_WHEEL);
    expect(() => buildEnvWarmArgs({ backend: 'mlx-vlm' })).toThrow(/bundledMlxVlmWheel/);
    expect(() => buildEnvWarmArgs({ backend: 'mlx-vlm', workerScript: '' })).toThrow();
    expect(baseWorkerWith('mlx-vlm', MFLUX_PIN, undefined, '/w/x.whl')).toEqual(['/w/x.whl']);
  });

  it('adds the frozen-resolve flags to mlx-vlm only; every other argv is unchanged', () => {
    expect(backendUvFlags('mlx-vlm')).toEqual(FROZEN);
    const others: Backend[] = [
      'mflux',
      'mlx-audio',
      'torch-tts',
      'triposr',
      'trellis',
      'hyperframes',
      'comfyui',
    ];
    for (const backend of others) {
      expect(backendUvFlags(backend)).toEqual([]);
      const job = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend });
      expect(job.slice(0, 4)).toEqual(['run', '--no-project', '--python', DEFAULT_PYTHON_VERSION]);
      expect(job).not.toContain('--exclude-newer');
      expect(job).not.toContain('--no-build');
      expect(job.some((a) => a.endsWith(MLX_VLM_WHEEL))).toBe(false);
    }
  });

  it('freezes the resolve at an instant uv accepts (RFC 3339, UTC)', () => {
    expect(MLX_VLM_RESOLVED_BEFORE).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(MLX_VLM_RESOLVED_BEFORE))).toBe(false);
  });
});

describe('the shipped mlx-vlm wheel matches its recipe', () => {
  const dir = path.join(PYTHON_DIR, 'mlx-vlm-ming');
  const script = readFileSync(path.join(dir, 'build-wheel.sh'), 'utf8');
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}='?([^'\\s]+)'?`, 'm').exec(script)?.[1];

  it('ships the wheel the argv names, beside worker.py', () => {
    expect(existsSync(path.join(PYTHON_DIR, 'worker.py'))).toBe(true);
    expect(existsSync(bundledMlxVlmWheel(path.join(PYTHON_DIR, 'worker.py')))).toBe(true);
  });

  it('builds from the pinned commit, at the pinned version, frozen at the same instant', () => {
    expect(field('SHA')).toBe(MLX_VLM_COMMIT);
    expect(MLX_VLM_WHEEL).toBe(`mlx_vlm-${field('VERSION')}-py3-none-any.whl`);
    expect(field('RESOLVED_BEFORE')).toBe(MLX_VLM_RESOLVED_BEFORE);
    // The source is checked, not trusted: a sha256 of the archive, 64 hex digits.
    expect(field('ARCHIVE_SHA256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the resolution it was measured with (resolved.txt)', () => {
    const resolved = readFileSync(path.join(dir, 'resolved.txt'), 'utf8');
    expect(resolved).toContain(`--exclude-newer ${MLX_VLM_RESOLVED_BEFORE}`);
    expect(resolved).toContain('--no-build');
    expect(resolved).toContain(MLX_VLM_WHEEL);
    // Pins only (name==version): nothing floats inside a frozen env.
    const pins = resolved.split('\n').filter((l) => /^[a-z0-9]/i.test(l));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin).toMatch(/^[A-Za-z0-9_.-]+==\S+/);
  });

  it('is the wheel the README documents (sha256)', () => {
    const wheel = readFileSync(bundledMlxVlmWheel(path.join(PYTHON_DIR, 'worker.py')));
    const sha = createHash('sha256').update(wheel).digest('hex');
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain(sha);
  });

  it('carries exactly the four patches, each confined to the Ming model', () => {
    const patches = readdirSync(path.join(dir, 'patches')).sort();
    expect(patches).toEqual([
      '0001-on-step-callback.patch',
      '0002-encode-once-many-seeds.patch',
      '0003-per-layer-quantization.patch',
      '0004-per-layer-eval.patch',
    ]);
    for (const name of patches) {
      const body = readFileSync(path.join(dir, 'patches', name), 'utf8');
      const touched = [...body.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
      expect(touched.length).toBeGreaterThan(0);
      for (const file of touched)
        expect(file).toMatch(/^mlx_vlm\/models\/ming_image\/[a-z_]+\.py$/);
    }
  });
});
