#!/usr/bin/env bash
# Regenerate build/icon.png + build/icon.icns from build/icon.svg.
#
# THE BUG THIS FIXES. The committed icon.png had an OPAQUE WHITE canvas — alpha
# at (0,0) was 1 — so macOS drew the full 1024x1024 square and the white showed
# as a border ring around the dark squircle. The user, with a screenshot: "size the
# app icon to remove the white border currently present."
#
# `-b none` is the whole fix: render the SVG onto TRANSPARENT, so only the
# squircle is opaque and macOS masks it the way it masks every other app icon.
# The ~100px inset inside the 1024 canvas is deliberate and correct — it is the
# Big Sur icon grid, not padding to remove.
set -euo pipefail
cd "$(dirname "$0")/.."
SVG=build/icon.svg
PNG=build/icon.png
SET=build/icon.iconset

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)"; exit 1; }

rsvg-convert -w 1024 -h 1024 -b none "$SVG" -o "$PNG"

# Fail loudly if the background came back opaque — that is the regression.
alpha=$(magick "$PNG" -format "%[fx:p{0,0}.a]" info:)
if [ "$alpha" != "0" ]; then
  echo "icon.png corner alpha is $alpha (expected 0) — background is not transparent"; exit 1
fi

rm -rf "$SET"; mkdir -p "$SET"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  set -- $spec
  rsvg-convert -w "$1" -h "$1" -b none "$SVG" -o "$SET/$2.png"
done

iconutil -c icns "$SET" -o build/icon.icns
rm -rf "$SET"
echo "wrote $PNG and build/icon.icns (transparent background)"
