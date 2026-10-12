#!/usr/bin/env bash
#
# Builds the desktop-cat installers on macOS and Linux.
#
# A thin wrapper so the build can be run straight from a shell without going through
# npm. Every argument is passed through untouched.
#
#   ./scripts/build.sh
#   ./scripts/build.sh --linux --arch x64
#   ./scripts/build.sh --help

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname -- "$here")"

if ! command -v node >/dev/null 2>&1; then
  echo "error  node is not on PATH. Install Node.js 20 or newer." >&2
  exit 1
fi

if [ ! -d "$root/node_modules/electron-builder" ]; then
  echo "installing dependencies..."
  npm --prefix "$root" ci
fi

exec node "$here/build-installers.mjs" "$@"
