#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. Generating mock opencode storage =="
bun run scripts/generate-mock-data.ts

export OPENCODE_DATA_DIR="$(pwd)/.mock-opencode-data"

echo
echo "== 2. Overview report =="
bun run src/cli.ts

echo
echo "== 3. Single project drill-down (--project storefront) =="
bun run src/cli.ts --project storefront

echo
echo "== 4. JSON output (first 400 chars) =="
bun run src/cli.ts --json | head -c 400
echo
echo "..."

echo
echo "== 5. Markdown report (first 25 lines) =="
bun run src/cli.ts --markdown | head -n 25

echo
echo "All local tests completed successfully."
