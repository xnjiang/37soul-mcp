#!/usr/bin/env bash
# Bump the version everywhere it lives. This package ships to npm AND to the
# official MCP Registry, and the registry refuses a server.json whose version
# does not match the npm package it points at — so these must never drift.
#
#   ./scripts/bump-version.sh 0.4.4
set -euo pipefail

new="${1:-}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <semver>   e.g. $0 0.4.4" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

current=$(jq -r .version package.json)
if [ "$current" = "$new" ]; then
  echo "Already at $new — nothing to do."
  exit 0
fi
echo "Bumping $current -> $new"

tmp=$(mktemp)
jq --arg v "$new" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json

# The version the running server reports over MCP, so clients see the real one.
perl -pi -e 's/^(const MCP_VERSION = ")[^"]+(";)/${1}'"$new"'${2}/' src/index.ts

# server.json is only present once the server is registered.
if [ -f server.json ]; then
  tmp=$(mktemp)
  jq --arg v "$new" '
    .version = $v
    | .packages = [.packages[] | if .identifier == "37soul-mcp" then .version = $v else . end]
  ' server.json > "$tmp" && mv "$tmp" server.json
fi

report() { printf '%-24s %s\n' "$1" "$2"; }
report "package.json" "$(jq -r .version package.json)"
report "src/index.ts" "$(grep -o 'const MCP_VERSION = "[^"]*"' src/index.ts | cut -d'"' -f2)"
[ -f server.json ] && report "server.json" "$(jq -r .version server.json)"
[ -f server.json ] && report "server.json packages" "$(jq -r '[.packages[] | select(.identifier=="37soul-mcp") | .version] | unique | join(",")' server.json)"

# Fail rather than leave a half-bumped tree — that state is exactly how npm and
# the registry end up pointing at different versions.
expected=$(jq -r .version package.json)
checks=( "$(grep -o 'const MCP_VERSION = "[^"]*"' src/index.ts | cut -d'"' -f2)" )
if [ -f server.json ]; then
  checks+=( "$(jq -r .version server.json)" )
  checks+=( "$(jq -r '[.packages[] | select(.identifier=="37soul-mcp") | .version] | unique | join(",")' server.json)" )
fi
for got in "${checks[@]}"; do
  if [ "$got" != "$expected" ]; then
    echo >&2
    echo "::error:: version mismatch after bump ($got != $expected) — fix by hand before publishing" >&2
    exit 1
  fi
done

echo
echo "All in agreement. Next: npm test && npm publish --access public, then commit + push."
