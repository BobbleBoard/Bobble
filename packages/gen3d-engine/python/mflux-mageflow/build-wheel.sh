#!/bin/sh
# Build the mflux wheel Bobble 3D's image hop and the chat's edit_image run on:
# the Mage-Flow port (mflux-community/mflux#483, ivanfioravanti — closed
# unmerged as stale on 2026-08-16, so NO mflux release on PyPI has it: 0.18.0
# through 0.20.0 carry no `mflux-generate-mage-flow`), pinned by commit, as a
# wheel the app ships in prebuilt/darwin-arm64/. A wheel, not a git or archive
# URL: nothing on a user's Mac depends on GitHub, a fork that may disappear, or
# a build backend at install time, and the bytes are the ones that were tested.
#
#   sh packages/gen3d-engine/python/mflux-mageflow/build-wheel.sh
#
# Needs `uv` and the network (the source archive, uv_build). Reproducible: the
# same commit gives the same wheel contents.
set -eu
SHA=859eeeca40b0c47a7bc2d8941072f0220e3425cf   # ivanfioravanti/mflux mage-flow-mlx head, 2026-07-23 (PR #483)
VERSION='0.18.0+bobble.mageflow.859eeec'       # the branch's own version + our label
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../prebuilt/darwin-arm64"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "fetching mflux@$SHA…"
curl -fsSL "https://github.com/ivanfioravanti/mflux/archive/$SHA.tar.gz" -o "$WORK/src.tgz"
tar -xzf "$WORK/src.tgz" -C "$WORK"
SRC="$WORK/mflux-$SHA"
# The version is what `uv` prints and what a saved model records (mflux_version).
sed -i '' "s/^version = \"0.18.0\"$/version = \"$VERSION\"/" "$SRC/pyproject.toml"
grep -q "^version = \"$VERSION\"" "$SRC/pyproject.toml"
( cd "$SRC" && uv build --wheel --out-dir "$WORK/dist" )
cp "$WORK"/dist/mflux-*.whl "$OUT/"
ls -la "$OUT"/mflux-*.whl
