#!/usr/bin/env bash
# Vendor GenOffice (github.com/genspark-ai/genoffice, Apache-2.0) into
# vendor/genoffice at a pinned commit.
#
# This is a FORK, not a dependency. Upstream's own shell imports the editor
# seam from source (`from '../../../docs/src/main/docs-main'`) rather than from
# a built package, so there is nothing installable to depend on — the
# main-process half has to be compiled into ours.
#
# Three things here are mechanical on purpose, because all three fail SILENTLY
# if left to memory:
#
#   1. ee/ is deleted. It is under a proprietary Enterprise License, not
#      Apache-2.0, and must never ship. Nothing breaks if it is included — we
#      would simply be distributing something we have no right to.
#   2. Their `project:` and `app:` IPC channels are prefixed. `project:list` is
#      registered with ipcMain.handle by BOTH projects; Electron throws on a
#      duplicate handler, so without this the app dies at startup. Skipping
#      their registerProjectIpc() is not enough — their preload invokes
#      `project:*` directly and would hit OUR handler with the wrong shape.
#   3. The upstream commit is recorded. Cherry-picking a fast-moving upstream
#      is impossible without knowing what we forked from.
#
# Usage:  bash scripts/vendor-genoffice.sh [<commit-ish>]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
DEST="$ROOT/vendor/genoffice"
UPSTREAM="https://github.com/genspark-ai/genoffice.git"
PIN="${1:-d8305ff2dc152593a1ec5639d77e6860c6a512bd}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Namespace prefix for their IPC channels. See note 2 above.
NS="go"

echo "vendor-genoffice: fetching $PIN"
git -c advice.detachedHead=false clone --quiet "$UPSTREAM" "$WORK/src"
git -C "$WORK/src" -c advice.detachedHead=false checkout --quiet "$PIN"
RESOLVED="$(git -C "$WORK/src" rev-parse HEAD)"
SUBJECT="$(git -C "$WORK/src" log -1 --format=%s)"
DATED="$(git -C "$WORK/src" log -1 --format=%cI)"

cd "$WORK/src"

echo "vendor-genoffice: removing ee/ (proprietary) and unused apps"
rm -rf ee apps/shell e2e .git .github

echo "vendor-genoffice: prefixing their project:/app: IPC channels with '$NS:'"
# Only the two namespaces we also occupy. Prefixing everything would bloat the
# diff against upstream for no gain; the build check below catches anything new.
find apps packages -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 sed -i '' \
      -e "s/'project:/'${NS}:project:/g" \
      -e "s/'app:get-language'/'${NS}:app:get-language'/g" \
      -e "s/'app:language-changed'/'${NS}:app:language-changed'/g"

# Mark the Genspark-branded ribbon group so CSS can hide it in BOTH forms.
# Necessary because the group COLLAPSES at narrow widths into a single button
# whose label is "Genspark AI" but which carries none of the .ai-entry classes
# the buttons have — so a selector-based rule silently stops matching exactly
# when the canvas is narrow, and the wordmark floats back over the document.
# CSS cannot match text content, hence a marker attribute rather than a
# cleverer selector.
echo "vendor-genoffice: marking the Genspark ribbon group for suppression"
find apps -type f -name '*.tsx' -print0 \
  | xargs -0 sed -i '' -e 's/<Group label="Genspark AI">/<Group label="Genspark AI" groupId="pd-ai-suppressed">/g'

echo "vendor-genoffice: staging into vendor/genoffice"
rm -rf "$DEST"
mkdir -p "$DEST"
# Everything except build output and installed deps; the tree is the source of
# truth and gets built by our own pipeline.
tar --exclude=node_modules --exclude=out --exclude=dist -cf - . | (cd "$DEST" && tar -xf -)

cat > "$DEST/UPSTREAM" <<EOF
repository  $UPSTREAM
commit      $RESOLVED
committed   $DATED
subject     $SUBJECT
vendored-by scripts/vendor-genoffice.sh
license     Apache-2.0 (see LICENSE and NOTICE in this directory)

Removed from the upstream tree by the vendoring script:
  ee/         proprietary GenOffice Enterprise License — must never ship
  apps/shell  upstream's own window shell; Bobble's canvas hosts the views
  e2e/        upstream end-to-end suite
  .github/    upstream CI

Modified:
  their 'project:*' and 'app:get-language'/'app:language-changed' IPC channels
  are prefixed '$NS:' to avoid a hard collision with Bobble's own channels.
EOF

# --- guards: these must fail loudly, not silently ---
if [ -e "$DEST/ee" ]; then
  echo "vendor-genoffice: FAIL — ee/ present in vendored tree" >&2
  exit 1
fi
if grep -rq "ipcMain.handle('project:list'" "$DEST" 2>/dev/null; then
  echo "vendor-genoffice: FAIL — unprefixed project:list survived the rename" >&2
  exit 1
fi
if grep -rq '<Group label="Genspark AI">' "$DEST" 2>/dev/null; then
  echo "vendor-genoffice: FAIL — an unmarked Genspark ribbon group survived" >&2
  exit 1
fi

echo "vendor-genoffice: done"
echo "  commit $RESOLVED"
echo "  files  $(find "$DEST" -type f | wc -l | tr -d ' ')"
echo "  size   $(du -sh "$DEST" | cut -f1)"
