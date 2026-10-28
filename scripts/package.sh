#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./manifest.json").version')
out="dist/igor-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -q -r "$out" manifest.json src
echo "$out"
