#!/usr/bin/env bash
# Build the desktop app, package it unsigned, ad-hoc sign, and install to
# /Applications so the latest build is always a double-click away.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm turbo run build --filter @pi-desktop/desktop
# Build the Apple Foundation Models Swift helper (pi-afm) so it exists for
# electron-builder to bundle (extraUnpackedDir via asarUnpack). No-op-safe on
# non-arm64: the build just produces the mach-o under swift/.build/release.
pnpm --filter @pi-desktop/afm build:swift
# Build the Mac computer-use Swift helper (pi-mac) the same way — it is
# asarUnpack'd and spawned by main (pi-mac --serve). arm64/macOS-only.
pnpm --filter @pi-desktop/pi-mac build:swift
# THE OFFICE EDITORS ARE BUILD OUTPUTS, NOT SOURCES. vendor/genoffice's out/
# folders and the sheets sidecar are ignored by git, so a fresh worktree has none
# of them — and electron-builder packages their absence without a word
# (2026-09-24: a candidate built in a new worktree was installed with no office
# editors). Stop here, before five minutes of packaging.
for need in \
  vendor/genoffice/embed/out/index.cjs \
  vendor/genoffice/embed/out/assets/harfbuzz.wasm \
  vendor/genoffice/apps/docs/out/renderer/index.html \
  vendor/genoffice/apps/sheets/out/renderer/index.html \
  vendor/genoffice/apps/slides/out/renderer/index.html \
  vendor/genoffice/apps/pdf/out/renderer/index.html \
  vendor/genoffice/apps/markdown/out \
  vendor/genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar; do
  [ -e "$need" ] || {
    echo "ship-local: $need is missing — build vendor/genoffice here, or copy its out/ folders and the sidecar from a checkout that has them" >&2
    exit 1
  }
done
pnpm --filter @pi-desktop/desktop exec electron-builder --dir --config electron-builder.yml

# A STABLE signing identity (scripts/signing-identity.sh explains why ad-hoc
# signing silently revoked computer use on every ship).
SIGN_ID="$(bash scripts/signing-identity.sh)"
SIGN_KEYCHAIN="$HOME/Library/Keychains/bobble-signing.keychain-db"
sign() { codesign --force --keychain "$SIGN_KEYCHAIN" --sign "$SIGN_ID" "$@"; }

APP_SRC="apps/desktop/release/mac-arm64/Bobble.app"
[ -d "$APP_SRC" ] || APP_SRC="apps/desktop/release/mac/Bobble.app"
[ -d "$APP_SRC" ] || { echo "ship-local: packaged app not found under apps/desktop/release" >&2; exit 1; }

# Sign the pi-afm mach-o FIRST (codesign requires inner code signed before the
# enclosing bundle). It is unpacked to app.asar.unpacked; ad-hoc is fine locally.
# (Developer-ID signing + notarizing this helper as a separate mach-o is W11.)
AFM_HELPER="$APP_SRC/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/afm/swift/.build/release/pi-afm"
if [ -f "$AFM_HELPER" ]; then
  sign "$AFM_HELPER"
  echo "ship-local: signed pi-afm helper"
else
  echo "ship-local: WARNING pi-afm helper not bundled at $AFM_HELPER" >&2
fi

# Sign the pi-mac mach-o (Mac computer-use helper) before the enclosing bundle,
# same as pi-afm. The Accessibility + Screen-Recording TCC grants attribute to
# the signed identity; ad-hoc is fine locally (stable Developer-ID signing is W11).
MAC_HELPER="$APP_SRC/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac"
if [ -f "$MAC_HELPER" ]; then
  sign "$MAC_HELPER"
  echo "ship-local: signed pi-mac helper"
else
  echo "ship-local: WARNING pi-mac helper not bundled at $MAC_HELPER" >&2
fi

# The sheets editor's Rust sidecar (vendored GenOffice, shipped as a resource
# by electron-builder.yml) is a bare mach-o under Resources, which `--deep`
# does not visit — unsigned, Gatekeeper refuses to exec it and every .xlsx tab
# opens empty. Signed like the two helpers above.
XLSX_SIDECAR="$APP_SRC/Contents/Resources/genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar"
if [ -f "$XLSX_SIDECAR" ]; then
  sign "$XLSX_SIDECAR"
  echo "ship-local: signed xlsx-sidecar"
else
  echo "ship-local: WARNING xlsx-sidecar not bundled at $XLSX_SIDECAR" >&2
fi

sign --deep "$APP_SRC"
# Print the requirement the TCC grants attach to. If this ever goes back to
# reading `cdhash H"…"`, computer-use permissions are about to be revoked by
# the next build and the cause is right here.
echo "ship-local: $(codesign -d -r- "$APP_SRC" 2>&1 | grep designated || true)"

# CHECK THE BUNDLE BEFORE IT REPLACES ANYTHING. Boot/theme probe, then the
# packaging smoke: proves the bundle loads its 3 pi extensions, spawns pi from the
# bundled cli.js, and serves the pd-preview canvas harness (the old ship regressed
# to `count: 0` extensions and dev-only chat). They used to run on the INSTALLED
# copy, after the old one was deleted — so a bundle that failed them was already
# in /Applications when they said so (2026-09-24). The copy below is these same
# bytes (ditto), so checking them here proves the same thing and risks nothing.
# Set SMOKE_MODEL=1 to also stream a real Gemma completion when the model +
# llama.cpp are cached at ~/.cache/pi-desktop.
APP_ABS="$(cd "$(dirname "$APP_SRC")" && pwd)/$(basename "$APP_SRC")"
(cd apps/desktop && node tests/e2e/packaged-probe.mjs "$APP_ABS")
(cd apps/desktop && node tests/e2e/packaged-smoke.mjs "$APP_ABS")

DEST="/Applications/Bobble.app"
# Never replace the bundle under a running Bobble: its lazily loaded chunks would
# then resolve against the NEW asar (other hashes) and fail. Ask it to quit the
# way a person would (it saves and stops its own model servers), wait, and stop
# here rather than force it — the user may be mid-task. (2026-09-24: a ship ran with
# The user's Bobble open because the running-check and the ship shared one command.)
if pgrep -f "$DEST/Contents/MacOS/Bobble" >/dev/null; then
  echo "ship-local: Bobble is running — asking it to quit"
  # The Apple Event can go unheard (no Automation grant for whatever runs this
  # script): 2026-10-08 the ship waited 30s on a Bobble that never got the ask.
  # So after 10s, SIGTERM the main process. It is the same quit, not a force:
  # Electron turns it into app.quit(), and before-quit's hold (pi/quit-hold.ts)
  # still stops pi and the model servers.
  osascript -e 'tell application "Bobble" to quit' >/dev/null 2>&1 || true
  for i in $(seq 1 60); do
    pgrep -f "$DEST/Contents/MacOS/Bobble" >/dev/null || break
    if [ "$i" -eq 20 ]; then
      echo "ship-local: no answer to the Apple Event — sending SIGTERM (a normal quit)"
      pkill -TERM -f "^$DEST/Contents/MacOS/Bobble( |\$)" || true
    fi
    sleep 0.5
  done
  if pgrep -f "$DEST/Contents/MacOS/Bobble" >/dev/null; then
    echo "ship-local: Bobble is still running after 30s — not replacing it; quit it and ship again" >&2
    exit 1
  fi
fi
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

# The installed copy is the checked bundle, byte for byte and still signed.
codesign --verify --deep --strict "$DEST"

# CLEAN UP THE ORPHAN THIS SCRIPT JUST MADE.
#
# Booting the app auto-starts the last-selected model, and packaged-smoke ends
# with `child.kill('SIGKILL')` — no handler runs, so the llama-server grandchild
# is reparented to init and keeps the whole model resident. MEASURED after a ship
# on 2026-08-16: one orphaned 27B server, free memory 10%, and the next thing to
# want the GPU died with "Compute error". It looked like a model bug. It was this.
#
# The app reaps orphans on LAUNCH (electron/inference/reap-orphans.ts, which owns
# the real selection rule and is unit-tested). That covers a user opening Bobble;
# it does nothing for the window between this script exiting and the next launch,
# which is exactly when someone runs a benchmark and measures a ghost. So the
# script that creates the orphan disposes of it, rather than leaving it for the
# next process to trip over.
#
# Deliberately narrow: only llama-server, only from our own cache root, only
# reparented to init (ppid 1). A server owned by a LIVE app always has a live
# parent, so a running Bobble is never touched.
LLAMA_ROOT="$HOME/.cache/pi-desktop/llamacpp"
orphans=$(ps -axo pid=,ppid=,command= \
  | awk -v root="$LLAMA_ROOT" '$2 == 1 && index($0, "llama-server") && index($0, root) { print $1 }')
if [ -n "$orphans" ]; then
  # shellcheck disable=SC2086
  kill -9 $orphans 2>/dev/null || true
  echo "ship-local: reaped orphaned llama-server(s) left by the smoke test: $(echo $orphans | tr '\n' ' ')"
fi

echo "ship-local: installed $(defaults read "$DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?') → $DEST"
