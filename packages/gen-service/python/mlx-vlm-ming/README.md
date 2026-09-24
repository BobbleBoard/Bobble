# Ming-Image on MLX: the mlx-vlm build Bobble ships

The design models (Ming-Image-0.1-Design, Ant Ling / inclusionAI, MIT) run on
mlx-vlm at commit `7b3397a621533fbebe31be0d9ac05441f2e7d845`. That is the
merge of Blaizzy/mlx-vlm#2334 on 2026-09-23, which added Ming text-to-image.
No PyPI release has it yet: 0.7.2 is from 09-21. A bare `mlx-vlm` would
resolve 0.7.2, import fine, and fail at the first picture. So the app ships
a wheel built from that commit's source archive plus four patches, and never
asks PyPI for mlx-vlm.

This folder is everything needed to reproduce and check the wheel in
`../wheels/`:

- `build-wheel.sh`: fetches the pinned commit's archive, checks its sha256,
  applies `patches/` with zero fuzz and builds the wheel. There is no git at
  build time and none on a user's Mac, so no Command Line Tools dialog.
- `patches/0001…0004`: the four changes below. Each is confined to
  `mlx_vlm/models/ming_image/`, black/isort-formatted like upstream, and
  written to be sent upstream.
- `tiny_ming.py`: a ~3 MB Ming checkpoint with random weights, in the same
  on-disk layout as the real MLX conversions. It runs the real pipeline end
  to end at 256×256 with no download. The Bobble driver's tests (MING-1) can
  reuse it.
- `test_patches.py`: the patches' tests, on the real code, with that
  checkpoint.
- `inspect_env.py`: the env report used below (import graph, sizes, import
  time).
- `check.sh`: all three checks in the env the app builds.
- `resolved.txt`: the frozen resolution, all 53 pins, with the command that
  regenerates it. Diff it when the freeze moves.

## How the app runs it

`src/worker-command.ts` owns the argv. A job whose backend is `mlx-vlm`
(`buildWorkerUvArgs`) runs:

    uv run --no-project --python 3.12 --no-build --exclude-newer 2026-09-24T00:00:00Z \
      --with <gen-worker>/wheels/mlx_vlm-0.7.3.dev0+bobble.ming-py3-none-any.whl \
      python <gen-worker>/worker.py

- **The wheel.** `MLX_VLM_WHEEL` is resolved beside the worker.py being
  launched (`bundledMlxVlmWheel`). The whole `python/` folder ships as
  `<Resources>/gen-worker`, so the wheel is where the argv says in the
  packaged app too. Without a path the builder throws rather than guess. The
  package's own path is wrong inside the bundled Electron main (see the note
  on `resolveWorkerScript` in gen-manager.ts).
- **`--exclude-newer`** (`MLX_VLM_RESOLVED_BEFORE`): the env resolves as PyPI
  stood at that instant, which is the resolution measured below. mlx-vlm's
  floors are days old (transformers>=5.14, mlx>=0.32.2). An open resolve
  would hand each user whatever shipped that morning, untested. Bump it
  together with the wheel.
- **`--no-build`**: a resolve that would need a compiler fails with uv's
  message instead of reaching for one. The measured resolve needs none.
- **The module card's env warm** (`buildEnvWarmArgs({ backend: 'mlx-vlm',
  workerScript })`) passes the same flags and the same wheel, so the warm and
  the job resolve one env. A unit test asserts that.

## The wheel

| | |
|---|---|
| file | `mlx_vlm-0.7.3.dev0+bobble.ming-py3-none-any.whl`, 3,082,921 bytes |
| sha256 | `94a46735db31b3b0689732440839c304724c76da51b0f212077b9b494fbe8d6f` |
| source | `github.com/Blaizzy/mlx-vlm/archive/7b3397a6…d845.tar.gz`, sha256 `2bbc1ffc82362639aa77994283a75064e21cd73bab215bfa96a63f106ad1cebf` |
| version | `0.7.3.dev0+bobble.ming`: the release in development plus our label. The commit itself still says 0.7.2 |
| reproducible | yes: a rebuild from an empty uv cache is byte-identical (measured). The build tools resolve at the same instant, and the zip timestamps are the commit's (`SOURCE_DATE_EPOCH`) |
| contents | every file of PyPI's 0.7.2 wheel, plus the 25 added since (`ming_image/` among them). `Requires-Dist` equals the commit's requirements.txt |

## The patches

| patch | what it changes | why |
|---|---|---|
| `0001-on-step-callback` | `generate_array(on_step=fn)` calls `fn(step, steps)` after each evaluated step. `generate_image(…, on_step=fn)` reaches it through `request.extra` | Upstream runs all steps in one call with nothing in between, so there was nothing to drive the card's "step 7/12" and its ETA |
| `0002-encode-once-many-seeds` | `encode(prompt)`; `generate_array(conditioning=…)`; `generate_seeds(prompt, seeds)` yields `(seed, image)` after ONE encode. An evicted encoder is loaded back, with the DiT and VAE dropped first | The encoder is a ~16B MoE (~10 GB at 4 bits), evicted after each run. Upstream, N pictures meant N encodes. `num_images` shares ONE noise key, so a seed does not reproduce alone. A second prompt on the same pipeline crashed: `'NoneType' object has no attribute 'encode'` |
| `0003-per-layer-quantization` | Each module loads at the precision it was saved with. A per-path entry in the config wins (mlx-vlm's convention); otherwise the packed shapes decide | Upstream loads every quantized module at the config's one bits/group size, so a mixed checkpoint (8-bit attention beside 4-bit experts) cannot load: `Expected shape (128, 8) but received shape (128, 16)`. MING-5's recipe needs mixed checkpoints: for Qwen-Image 2.1, a 4-bit encoder flipped letters in rendered words (`../mflux-qwen21/README.md`) |
| `0004-per-layer-eval` | `mx.eval` after each encoder layer | One lazy graph over all 20 layers keeps every layer's routed experts live until the end. That defeats `moe_offload`'s byte budget, as its own docstring warns. This comes before an offloaded 8-bit encoder on 24 GB, and before any Ming on 16 GB (MING-13). The numbers are unchanged (tested: identical hidden states) |

## The env

Measured on 2026-09-23 on this M5 Pro (macOS 27.2) with uv 0.11.26, from an
**empty `UV_CACHE_DIR`**, with exactly the argv above.

- **Resolution**: 53 PyPI packages plus the wheel. Every one is a wheel:
  **0 source builds**. The `--no-build` resolve succeeds natively and at the
  macOS 14 floor (mlx publishes wheels for macOS 14+). Each pin has a
  cp312/abi3/py3 macOS-arm64 file on PyPI.
- **Download**: **158.1 MB**. The largest wheels are opencv-python 48.3,
  mlx-metal 42.5, scipy 20.5, transformers 12.3, numpy 5.5 and pillow 4.8 MB.
  Python 3.12.13 was already on this Mac (uv-managed); elsewhere uv fetches
  it once.
- **First warm**: 3.1 s on this connection (`Installed 54 packages in 122ms`).
- **Installed**: **576 MB** across 55 distributions (RECORD sizes; pip comes
  with the interpreter). The largest are mlx-metal 209, opencv-python 125,
  scipy 70, transformers 49, numpy 21, pillow 13, mlx-vlm 11 and tokenizers
  10 MB. `du` reports 1.2 GB for the uv cache afterwards: the unpacked wheels
  plus the env built from them. uv clones those files on APFS, so the two
  share blocks and `du` counts them twice.
- **Import**: `import mlx_vlm.models.ming_image` takes 2.9 s the first time
  (bytecode is compiled) and about 0.65 s after (0.64 and 0.67 s in two
  runs). Of that, transformers takes 0.28 s, mlx-vlm 0.21, the standard
  library 0.04, huggingface_hub 0.03 and mlx 0.03 (`-X importtime`, own time
  per distribution).
- **Import graph**: the import loads 29 of the 55 distributions (**336 MB**):
  Jinja2, MarkupSafe, PyYAML, Pygments, anyio, certifi, charset-normalizer,
  click, filelock, h11, httpcore, httpx, huggingface_hub, idna, mlx,
  mlx-metal, mlx-vlm, numpy, packaging, pillow, regex, requests, rich,
  sentencepiece, tokenizers, tqdm, transformers, typing_extensions, urllib3.
  - The other 26 (**241 MB**) are installed and never imported. The big
    ones are opencv-python 125, scipy 70 (pulled by mlx-audio), hf-xet 8.2,
    llguidance 8.2, mlx-audio 7.7 and pip 5.6 MB. The rest is the fastapi,
    uvicorn and pydantic server stack, sounddevice, miniaudio and
    safetensors: MLX reads safetensors itself.
  - A later slim env (the wheel `--no-deps` plus those 29) would install
    about 336 MB. That only pays once it is proven against the real driver,
    since a runtime path may import lazily. Not done here.

## Verify

    sh packages/gen-service/python/mlx-vlm-ming/check.sh            # the shipped wheel
    FRESH=1 sh packages/gen-service/python/mlx-vlm-ming/check.sh    # the same, from an empty uv cache

It prints the import check, the env report and the patch tests. The
resolution alone (no install, no source builds allowed) is the command in
`resolved.txt`'s header. Add `--python-platform aarch64-apple-darwin` with
`MACOSX_DEPLOYMENT_TARGET=14.0` for the macOS 14 floor.

Measured results, 2026-09-23:

| wheel | test_patches.py |
|---|---|
| shipped (`+bobble.ming`) | **14/14 pass**: 6.5 s cold (kernels and bytecode compile), 0.6 s after |
| stock commit (`STOCK=1 OUT=<dir> sh build-wheel.sh`, then `WHEEL=<that> sh check.sh`) | **10 fail** (every patch test), 4 pass (the fixture and the two no-regression guards) |

The failures on the stock wheel are the reasons for the patches:
- `generate_array() got an unexpected keyword argument 'on_step'`;
- `'MingImagePipeline' object has no attribute 'generate_seeds'`;
- `'NoneType' object has no attribute 'encode'` (the second prompt);
- `Expected shape (128, 8) but received shape (128, 16)`;
- `0 != 3` evaluations.

`src/worker-command.test.ts` ties this folder to the app:
- `build-wheel.sh`'s commit, version and freeze instant equal the TS
  constants;
- the wheel is shipped beside worker.py;
- its sha256 is the one above;
- there are exactly these four patches, each confined to the Ming model.

## Not measured here

Real weights are a BENCH job (PLAN.md §4.4, MING-S0 and MING-4): the 13.4 GB
nativ-community 4-bit download, then s/step, peak memory and the OS
free-memory drop per phase at 1024². None of that is needed to build or check
the wheel. The tiny checkpoint covers the code paths, and the real run
covers the numbers.

## When this folder goes

When a PyPI mlx-vlm release contains `ming_image` and these four changes, or
their equivalents: `baseWorkerWith('mlx-vlm')` moves to a version pin, and
the wheel, this folder and the freeze go.

To move to a newer commit before then:
1. Update `SHA`, `ARCHIVE_SHA256`, `COMMIT_EPOCH`, `BASE_VERSION` and
   `VERSION` in `build-wheel.sh`.
2. Regenerate the patches against the new tree.
3. Rebuild.
4. Update `MLX_VLM_*` in `worker-command.ts`.
5. Re-run `check.sh`, then update the sha256 and the numbers above. The
   vitest drift test fails until the constants and this sha agree.
