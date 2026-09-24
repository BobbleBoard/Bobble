#!/bin/sh
# Verify a built wheel in the env the app builds for it: the same uv flags
# src/worker-command.ts gives an mlx-vlm job (buildWorkerUvArgs), so this is
# the env a design picture runs in. Three checks: the import, the env report
# (inspect_env.py) and the patch tests (test_patches.py, tiny random weights).
#
#   sh packages/gen-service/python/mlx-vlm-ming/check.sh     # the shipped wheel
#   WHEEL=<path.whl> sh .../check.sh                          # another build, e.g. STOCK=1's
#   FRESH=1 sh .../check.sh                                   # from an empty uv cache
#
# Downloads the env's 158 MB of wheels the first time (none of them a model).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
eval "$(grep -E '^(RESOLVED_BEFORE|VERSION)=' "$HERE/build-wheel.sh")"
WHEEL=${WHEEL:-"$HERE/../wheels/mlx_vlm-$VERSION-py3-none-any.whl"}
if [ "${FRESH:-0}" = 1 ]; then
  UV_CACHE_DIR=$(mktemp -d)
  export UV_CACHE_DIR
  trap 'rm -rf "$UV_CACHE_DIR"' EXIT
fi
in_env() {
  uv run --no-project --python 3.12 --no-build --exclude-newer "$RESOLVED_BEFORE" \
    --with "$WHEEL" "$@"
}
cd "$HERE"
in_env python -c "import mlx_vlm, mlx_vlm.models.ming_image; print('import ok:', mlx_vlm.__version__)"
in_env python inspect_env.py
in_env python -m unittest -v test_patches
