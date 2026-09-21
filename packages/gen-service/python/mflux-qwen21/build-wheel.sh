#!/bin/sh
# Build the mflux wheel Qwen-Image 2.1 runs on: the Qwen 2.1 port (an open
# pull request, pinned by commit) plus the one patch beside this script, as a
# wheel the app ships in python/wheels/ and hands to `uv run --with`. A wheel,
# not a git URL: nothing on a user's Mac depends on GitHub, a fork, or a
# build backend at picture time, and the bytes are the ones that were tested.
#
#   sh packages/gen-service/python/mflux-qwen21/build-wheel.sh
#
# Needs `uv` and the network (the source archive, uv_build). Reproducible: the
# same commit and patch give the same wheel contents.
set -eu
SHA=dc5af52025a323e9b6dd44b702f6fc941498f978   # mflux-community/mflux#736 head, 2026-09-20
VERSION='0.19.2+bobble.qwen21.te8'             # the PR's base release + our label (te8 = 8-bit text encoder under -q 4)
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../wheels"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "fetching mflux@$SHA…"
curl -fsSL "https://github.com/mflux-community/mflux/archive/$SHA.tar.gz" -o "$WORK/src.tgz"
tar -xzf "$WORK/src.tgz" -C "$WORK"
SRC="$WORK/mflux-$SHA"
( cd "$SRC" && patch -p1 --forward < "$HERE/quantized-text-encoder.patch" )
# The version is what `uv` prints and what a saved model records (mflux_version).
sed -i '' "s/^version = \"0.19.2\"$/version = \"$VERSION\"/" "$SRC/pyproject.toml"
grep -q "^version = \"$VERSION\"" "$SRC/pyproject.toml"
( cd "$SRC" && uv build --wheel --out-dir "$OUT" )
# uv drops a `*` .gitignore into its out dir; the wheel is meant to be committed.
rm -f "$OUT/.gitignore"
ls -la "$OUT"/mflux-*.whl
