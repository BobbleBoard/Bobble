# Prebuilt pieces of the 3D engine

the user (2026-09-15): "all basic stuff needs to work out of the box". A fresh Mac
has no git, no C++ compiler and no `metal` compiler, and three parts of the
engine used to need them:

- `mtldiffrast` and `flex_gemm` — the Metal rasteriser and sparse GEMM the MLX
  TRELLIS tree uses. Torch C++ extensions with Metal kernels: they build only
  with Xcode's `metal`, and they link against a specific torch (the manifest
  pins it — the provisioner installs that torch).
- `o_voxel` — the CPU shape encoder that texturing an existing mesh starts
  with. Plain C++ + Eigen; needs a compiler the Command Line Tools would
  provide, which a fresh Mac does not have either.
- `quadriflow` — the quad remesher. Was a hand-built binary nothing provisioned.

One more piece is here because it cannot be installed from PyPI at all:

- `mflux-…+bobble.mageflow…whl` — the mflux build with Mage-Flow (an
  unmerged port; no release has it). Pure Python; see
  `python/mflux-mageflow/README.md` for why and how it is built.

`darwin-arm64/manifest.json` names the set; `engine/envs.py` reads it and
installs the wheels instead of building from source, falling back to the
source build (which needs Xcode) on a platform with no manifest.

The wheels here were built once on a Mac that had Xcode and repacked from the
working environment. To rebuild: a venv with the manifest's torch, then
`pip wheel --no-build-isolation --no-deps <archive url>` with `DEVELOPER_DIR`
pointing at an Xcode.
