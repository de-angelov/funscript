#!/bin/sh
# Run from the repository root: sh scripts/toolchain.sh [status|install|update|uninstall] [--dry-run]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ACTION=${1:-status}
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

case "$ACTION" in status|install|update|uninstall) ;; *) echo "Usage: sh scripts/toolchain.sh [status|install|update|uninstall] [--dry-run]" >&2; exit 2;; esac

has() { command -v "$1" >/dev/null 2>&1; }
if ! has node || ! has npm; then
  echo "Node.js and npm are required to manage the checkout CLI. Install Node.js 20+ from https://nodejs.org/ (manual path), then retry."
  [ "$ACTION" = status ] || exit 1
  exit 0
fi
NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
LINKED=$(npm ls -g --depth=0 funscript 2>/dev/null || true)
echo "Node.js: $NODE_VERSION (installed; supported baseline: 20+)"
echo "npm: $NPM_VERSION (installed)"
case "$LINKED" in *funscript@*) echo "FunScript CLI: linked";; *) echo "FunScript CLI: not linked";; esac
if has code; then echo "VS Code CLI: available (extension management is manual; see docs/toolchain.md)"; else echo "VS Code CLI: missing"; fi

[ "$ACTION" = status ] && exit 0
case "$ACTION" in
  install|update) CMD="cd '$ROOT' && npm link";;
  uninstall) CMD="npm unlink -g funscript";;
esac
echo "Action: $ACTION FunScript CLI"
echo "Command: $CMD"
[ "$DRY" = 1 ] && exit 0
[ -t 0 ] || { echo "Interactive confirmation required; run in a terminal (or use --dry-run)." >&2; exit 2; }
printf 'Proceed with this command? [y/N] '
read answer
case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0;; esac
case "$ACTION" in
  install|update) (cd "$ROOT" && npm link);;
  uninstall) npm unlink -g funscript;;
esac
