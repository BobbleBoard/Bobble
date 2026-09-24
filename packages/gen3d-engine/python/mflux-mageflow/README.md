# Mage-Flow on MLX — the build Bobble ships

Bobble 3D's image hop (text → image → 3D) and the chat's `generate_image` /
`edit_image` run Mage-Flow-Turbo and Mage-Flow-Edit-Turbo on the mflux port by
ivanfioravanti (mflux-community/mflux#483). That pull request was closed
unmerged as stale on 2026-08-16, so **no mflux release has Mage-Flow**: PyPI's
0.18.0, 0.18.1, 0.19.x and 0.20.0 carry no `mflux-generate-mage-flow`. The
engine used to pin `mflux==0.18.0` — the port's own version string — which
installed the PyPI release without the commands, so a fresh Mac never had the
fast path (11 s against 71 s on PyTorch) and could not edit at all.

- `build-wheel.sh` — fetches the pinned commit (`859eeeca`, the branch head
  since 2026-07-23) and builds
  `mflux-0.18.0+bobble.mageflow.859eeec-py3-none-any.whl` into
  `../../prebuilt/darwin-arm64/`, where `prebuilt/darwin-arm64/manifest.json`
  names it (key `mflux`). `engine/envs.py` installs it into the
  `src/mflux` venv; the pinned source archive is the fallback where the
  prebuilt tree is absent.

## The weights

The port resolves `--model mage-flow-turbo` to `microsoft/Mage-Flow-Turbo`,
and Microsoft withdrew those repos (401 for everyone, 2026-09-23). So the
engine never passes a repo id: `jobs.py` hands mflux the checkpoint directory
(`--model <dir> --base-model mage-flow-turbo`, and `mage-flow-edit-turbo` for
edits) — a complete old `microsoft/*` snapshot where one is on disk, otherwise
the directory the sidecar assembles from Comfy-Org/Mage-Flow and
Qwen/Qwen3-VL-4B-Instruct, byte-identical to the release
(`src/mage-flow-release.ts`).

## When upstream ships it

If a later mflux release carries Mage-Flow, the manifest's `mflux` entry and
this folder go, and `MFLUX_MAGE_FLOW_SOURCE` in `engine/envs.py` becomes a
version pin. Re-check the quantization by eye when that happens: at 4 bits
this port renders noise while exiting 0 (`workers/mlx_image_worker.py`).
