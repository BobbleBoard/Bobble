#!/usr/bin/env bash
# Rebuild pi-mac and drop it into the INSTALLED bundle, signed with the stable
# identity so it keeps the Accessibility/Screen-Recording grants. This is the
# iteration loop for helper work: the grants live on the signed identity, so a
# helper run from anywhere else is blind.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release --package-path packages/pi-mac/swift >/dev/null
DEST="/Applications/Bobble.app/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac"
cp packages/pi-mac/swift/.build/out/Products/Release/pi-mac "$DEST"
codesign --force --keychain "$HOME/Library/Keychains/bobble-signing.keychain-db" \
  --sign "$(bash scripts/signing-identity.sh)" "$DEST" 2>/dev/null
"$DEST" --check
