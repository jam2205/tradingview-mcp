#!/bin/bash
# Installs the two systemd --user units (TradingView+CDP, and the always-on
# MCP HTTP server) so they can start automatically on login. Copies unit
# files and reloads the daemon, but does NOT enable or start them — run
# with --enable to also do that, or do it yourself:
#   systemctl --user enable --now tradingview-cdp.service tradingview-mcp-http.service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DIR"
# Unit files assume the repo lives at ~/tradingview-mcp; point them at wherever it actually is.
for unit in tradingview-cdp.service tradingview-mcp-http.service; do
  sed "s|%h/tradingview-mcp|$REPO_DIR|g" "$SCRIPT_DIR/$unit" > "$UNIT_DIR/$unit"
done
chmod +x "$SCRIPT_DIR/launch_tv_service.sh" "$SCRIPT_DIR/run_mcp_http.sh"

systemctl --user daemon-reload

echo "Installed:"
echo "  $UNIT_DIR/tradingview-cdp.service"
echo "  $UNIT_DIR/tradingview-mcp-http.service"
echo

if [ "${1:-}" = "--enable" ]; then
  systemctl --user enable --now tradingview-cdp.service tradingview-mcp-http.service
  echo "Enabled and started both services."
else
  echo "Not enabled yet. To enable + start now:"
  echo "  systemctl --user enable --now tradingview-cdp.service tradingview-mcp-http.service"
  echo "To just start once without enabling at login:"
  echo "  systemctl --user start tradingview-cdp.service tradingview-mcp-http.service"
fi
