#!/usr/bin/env bash
# Draw the extension icons with ImageMagick.
# Run: npm run icons
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p icons

for size in 16 48 128; do
  radius=$((size / 5))
  magick -size "${size}x${size}" xc:none \
    -fill "#2563eb" -draw "roundrectangle 0,0 $((size - 1)),$((size - 1)) ${radius},${radius}" \
    -fill "#ffffff" -draw "roundrectangle $((size * 22 / 100)),$((size * 28 / 100)) $((size * 78 / 100)),$((size * 72 / 100)) $((radius / 2)),$((radius / 2))" \
    -fill "#2563eb" -draw "circle $((size * 36 / 100)),$((size * 42 / 100)) $((size * 36 / 100)),$((size * 48 / 100))" \
    -fill "#2563eb" -draw "polygon $((size * 30 / 100)),$((size * 68 / 100)) $((size * 48 / 100)),$((size * 48 / 100)) $((size * 66 / 100)),$((size * 68 / 100))" \
    "icons/icon${size}.png"
done

echo "Wrote icons/icon16.png, icons/icon48.png, icons/icon128.png"
