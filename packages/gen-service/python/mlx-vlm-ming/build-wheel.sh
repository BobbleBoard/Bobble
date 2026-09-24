#!/bin/sh
# Build the mlx-vlm wheel Bobble's design models (Ming-Image-0.1-Design) run on:
# mlx-vlm at the commit that merged Ming support, which no PyPI release carries
# yet, plus the four patches in patches/. The app ships the wheel in
# python/wheels/ and hands it to `uv run --with`. A wheel, not a git URL:
# nothing on a user's Mac needs git (and with it the Command Line Tools
# dialog), GitHub, or a build at picture time, and the bytes are the ones that
# were tested.
#
#   sh packages/gen-service/python/mlx-vlm-ming/build-wheel.sh
#
# Needs `uv`, `curl`, `patch` and the network (the 25 MB source archive, and
# setuptools for the build). Reproducible: the archive is checked against its
# sha256, the build tools resolve as PyPI stood at RESOLVED_BEFORE, and every
# timestamp in the zip is the commit's, so the same inputs give a
# byte-identical wheel. The README records its sha256.
#
#   OUT=<dir>   write the wheel there instead of ../wheels
#   STOCK=1     skip the patches (label +bobble.stock): the before side of
#               test_patches.py's before/after check
set -eu
SHA=7b3397a621533fbebe31be0d9ac05441f2e7d845   # Blaizzy/mlx-vlm main, 2026-09-23: "Ming-Image-0.1-Design (text-to-image) support (#2334)"
ARCHIVE_SHA256=2bbc1ffc82362639aa77994283a75064e21cd73bab215bfa96a63f106ad1cebf
COMMIT_EPOCH=1790194754                        # 2026-09-23T20:19:14Z, the commit's date
BASE_VERSION='0.7.2'                           # what the commit still declares (the release before it)
VERSION='0.7.3.dev0+bobble.ming'               # the release in development + our label
RESOLVED_BEFORE='2026-09-24T00:00:00Z'         # = MLX_VLM_RESOLVED_BEFORE in src/worker-command.ts
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-"$HERE/../wheels"}
if [ "${STOCK:-0}" = 1 ]; then VERSION='0.7.3.dev0+bobble.stock'; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "fetching mlx-vlm@$SHA…"
curl -fsSL "https://github.com/Blaizzy/mlx-vlm/archive/$SHA.tar.gz" -o "$WORK/src.tgz"
echo "$ARCHIVE_SHA256  $WORK/src.tgz" | shasum -a 256 -c - >/dev/null
tar -xzf "$WORK/src.tgz" -C "$WORK"
SRC="$WORK/mlx-vlm-$SHA"
if [ "${STOCK:-0}" != 1 ]; then
  for p in "$HERE"/patches/*.patch; do
    # --fuzz=0: a patch applies to exactly the pinned source or the build stops.
    ( cd "$SRC" && patch -p1 --forward --fuzz=0 --quiet < "$p" )
    echo "applied $(basename "$p")"
  done
fi
# The version is what uv prints and what mlx_vlm.__version__ reports.
sed -i '' "s/^__version__ = \"$BASE_VERSION\"$/__version__ = \"$VERSION\"/" "$SRC/mlx_vlm/version.py"
grep -q "^__version__ = \"$VERSION\"$" "$SRC/mlx_vlm/version.py"
mkdir -p "$OUT"
( cd "$SRC" && SOURCE_DATE_EPOCH=$COMMIT_EPOCH uv build --wheel --no-build-logs \
    --exclude-newer "$RESOLVED_BEFORE" --out-dir "$OUT" )
# uv drops a `*` .gitignore into its out dir; the wheel is meant to be committed.
rm -f "$OUT/.gitignore"
shasum -a 256 "$OUT/mlx_vlm-$VERSION-py3-none-any.whl"
