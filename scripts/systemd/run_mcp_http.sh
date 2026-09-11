#!/bin/bash
# Runs the always-on Streamable HTTP MCP server under systemd --user.
# systemd user units start with a minimal PATH (no ~/.bashrc, no nvm init),
# so this resolves a real `node` binary the same way a login shell would
# before falling back to common install locations.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for cand in /usr/local/bin/node /usr/bin/node /snap/bin/node; do
    [ -x "$cand" ] && NODE_BIN="$cand" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "run_mcp_http.sh: could not find a node binary (checked PATH, nvm, common install paths)" >&2
  exit 1
fi

cd "$REPO_DIR"
exec "$NODE_BIN" src/server-http.js
