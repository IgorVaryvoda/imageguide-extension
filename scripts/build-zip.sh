#!/usr/bin/env bash
# Package the unpacked extension for the Chrome Web Store.
# Run: npm run zip
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
output="dist/imageguide-extension-${version}.zip"

rm -rf dist
mkdir -p dist

zip -r -q "$output" \
  manifest.json \
  icons \
  lib \
  content \
  extension \
  popup \
  audit \
  -x '*.DS_Store'

echo "Wrote $output"
