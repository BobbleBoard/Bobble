#!/usr/bin/env bash
# Build the pi-mac helper and sign it with the repo's STABLE local identity.
#
#   bash packages/pi-mac/scripts/build-signed.sh [--no-build]
#
# `swift build` leaves an ad-hoc, linker-signed binary whose designated
# requirement is its own cdhash — a new requirement on every build. Signing
# with `scripts/signing-identity.sh`'s certificate (the one ship-local.sh signs
# the bundled helper with) gives the requirement that does not move:
#
#   designated => identifier "pi-mac" and certificate leaf = H"…"
#
# so a helper built here and a helper shipped by ship-local.sh are the same TCC
# client (memory: pi-desktop-tcc-signing). Prints the requirement and FAILS if
# it is still a cdhash. Only ever signs this checkout's build output — never the
# helper inside /Applications/Bobble.app.
set -euo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
BIN="$PKG/swift/.build/release/pi-mac"
KEYCHAIN="$HOME/Library/Keychains/bobble-signing.keychain-db"

if [ "${1:-}" != "--no-build" ]; then
  swift build -c release --package-path "$PKG/swift" >&2
fi
[ -x "$BIN" ] || { echo "build-signed: no helper at $BIN" >&2; exit 1; }

ID="$(bash "$REPO/scripts/signing-identity.sh")"
codesign --force --keychain "$KEYCHAIN" --sign "$ID" --identifier pi-mac "$BIN"

REQ="$(codesign -d -r- "$BIN" 2>&1 | grep '^designated' || true)"
echo "$REQ"
case "$REQ" in
  *"certificate leaf"*) ;;
  *) echo "build-signed: requirement is not the stable identity ($REQ)" >&2; exit 1 ;;
esac
