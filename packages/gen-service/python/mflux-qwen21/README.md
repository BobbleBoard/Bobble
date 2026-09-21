# Qwen-Image 2.1 on MLX — the build Bobble ships

The default picture model runs on the mflux port of Qwen-Image 2.1
(mflux-community/mflux#736, ivanfioravanti), which is still a pull request.
This folder is everything needed to reproduce the wheel in `../wheels/`:

- `quantized-text-encoder.patch` — two changes: let the Qwen3-VL-8B text
  encoder be quantized with the DiT (upstream keeps it in bf16, 17.5 GB, which
  a 24 GB Mac cannot hold beside the model), and the recipe: under `-q 4`
  the encoder keeps 8 bits while the DiT takes 4.
- `build-wheel.sh` — fetches the pinned commit, applies the patch, builds
  `mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl` with `uv build`.

The app hands the wheel to `uv run --with` for this model only
(`MfluxBackendConfig.wheel` in the catalog); every other mflux model stays on
the pinned release (`MFLUX_PIN`). When upstream ships the port with a way to
quantize the encoder, the catalog entry moves to a version pin and this folder
goes.

## The weights

Nobody has published Qwen-Image 2.1 pre-quantized in mflux's own layout — the
hub's "MLX 4-bit" repos (`mlx-community/Qwen-Image-2.1-MLX-4bit` and friends)
are another runtime's tensor naming and mflux cannot read them. So the first
use fetches the 31 GB bf16 release and converts it here:

    mflux-save --model <release dir> --base-model qwen-image-2.1 -q 4 --path <shelf>/Image/Generation/qwen-image-2.1-mflux-4bit-te8

(18 s of conversion on an M5 Pro; the fetch is the wait; the release is
removed after — `installPrepared` in apps/desktop/electron/gen/gen-modules-main.ts.
The folder name carries the recipe: a plain uniform `-4bit` save is a
different model and is not adopted.)

To turn that into a 13 GB download for everyone, publish the converted folder
with a WRITE token:

    hf upload <org>/Qwen-Image-2.1-mflux-4bit-te8 ~/Bobble/Models/Image/Generation/qwen-image-2.1-mflux-4bit-te8 . --exclude model.json

then in the catalog set `mflux.model` to that repo and drop `mflux.prepared`.
The repo must carry the Qwen Research License (non-commercial) notice.

## Measured (2026-09-20, M5 Pro 24 GB, 4 bits, `--low-ram`)

| picture | steps | wall | per step | MLX peak | machine (OS free drop) |
| --- | --- | --- | --- | --- | --- |
| 1024² | 24 | 88–97 s | 3.4–3.6 s | 5.96 GB | ~7.4 GB |
| 768² | 24 | 49 s | 1.8 s | 5.86 GB | — |
| 1024², previews on | 24 | 181 s | 7.1 s | 20.45 GB | to 6% free — never |

12 steps come out garbled on this port (the schedule, not the quantization),
20 slightly broken, 24 clean; 8 bits is no faster (3.6 s/step, 8.8 GB).

## Why the encoder keeps 8 bits

Ten prompts with a word in the picture at one seed, plus the app's own neon
sign at three seeds and a poster at one, 24 steps at 1024²:

| recipe | exact | disk | MLX peak | machine (OS free drop) |
| --- | --- | --- | --- | --- |
| uniform 4-bit | 12/13 — "BOBBLE" came out "BOBBBLE" | 9.0 GB | 5.96 GB | ~7.4 GB |
| 4-bit with modulation + token embeddings at 8 | 10/11 — "VISIT" lost its "KYOTO" | 9.3 GB | 5.96 GB | — |
| **4-bit DiT, 8-bit encoder (this)** | 11/11 | 13 GB | 5.96 GB | ≤ uniform 4-bit's |
| 8-bit everything | 14/14 | 15.7 GB | 8.82 GB | more, and 5% slower |

The DiT at 4 bits renders every word it is conditioned on; the failures
came from the 4-bit encoder's conditioning. The encoder is one pass and
evicted before sampling (`--low-ram`), and its weights are file-backed
pages, so 8 bits there cost disk and nothing at run time.
