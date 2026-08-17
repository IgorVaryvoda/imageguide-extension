#!/usr/bin/env bash
# Turn the master art in images/ into the exact sizes Chrome and the README need.
# Run: npm run assets
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p icons store

# The generated icon is not perfectly square and it sits off centre.
# Trim it to the artwork, pad it back to a square, then scale each size.
square=$(mktemp -t imageguide-icon-XXXXXX.png)
trap 'rm -f "$square"' EXIT

magick images/icon-master.png \
  -trim +repage \
  -background none -gravity center -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" \
  "$square"

for size in 16 48 128; do
  magick "$square" -filter Lanczos -resize "${size}x${size}" \
    -unsharp 0x0.6+0.8+0 -strip "icons/icon${size}.png"
done

# Chrome Web Store listing art. The masters already carry the right ratios,
# so an exact resize costs no crop.
magick images/promo-small-master.png -filter Lanczos -resize '440x280!' \
  -strip store/promo-small-440x280.png

magick images/promo-marquee-master.png -filter Lanczos -resize '1400x560!' \
  -strip store/promo-marquee-1400x560.png

# The social card for imageguide.dev and the link previews.
magick images/social-card-master.png -filter Lanczos -resize '1200x630!' \
  -strip store/social-card-1200x630.png

# Feature cards for the README and the site.
for card in images/card-*.png; do
  magick "$card" -filter Lanczos -resize 800x800 -strip \
    "store/$(basename "${card%.png}")-800.png"
done

echo "Wrote:"
find icons store -type f -name '*.png' | sort | while read -r file; do
  printf '  %-42s %s\n' "$file" "$(magick identify -format '%wx%h %b' "$file")"
done
