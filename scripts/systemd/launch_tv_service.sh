#!/bin/bash
# Boot-time launcher for TradingView Desktop with CDP enabled, run under
# systemd (Type=simple) so the unit tracks the actual TradingView process
# and can restart it on crash.
#
# WORKAROUND: on this machine (KDE Plasma), TradingView's own startup
# synchronously calls `xdg-settings set default-url-scheme-handler` to
# register the tradingview:// URL scheme. That call shells out to KDE's
# `ktraderclient5`, which has been observed to hang indefinitely (not just
# slow — 200+ seconds and counting, never returning) rather than resolving
# a permission prompt or failing fast. TradingView blocks its own startup
# on that child process's exit, so the CDP port never opens until it's
# killed. Confirmed live 2026-09-11: killing the stuck xdg-settings/
# ktraderclient5 subtree immediately unblocked TradingView and CDP came up
# within ~2s. This watchdog waits for CDP directly and, if it hasn't
# appeared within WATCHDOG_TIMEOUT seconds, kills any such stuck children
# under the TradingView process so startup can complete. This is a
# generic self-heal (works regardless of root cause), not a permanent fix
# for the underlying KDE hang.

set -uo pipefail

PORT="${TV_CDP_PORT:-9222}"
WATCHDOG_TIMEOUT="${TV_LAUNCH_WATCHDOG_S:-20}"

LOCATIONS=(
  "/opt/TradingView/tradingview"
  "/opt/TradingView/TradingView"
  "$HOME/.local/share/TradingView/TradingView"
  "/usr/bin/tradingview"
  "/usr/local/bin/tradingview"
  "/snap/tradingview/current/tradingview"
  "/var/lib/flatpak/app/com.tradingview.TradingView/current/active/files/bin/tradingview"
  "$HOME/.local/share/flatpak/app/com.tradingview.TradingView/current/active/files/bin/tradingview"
)

APP=""
for loc in "${LOCATIONS[@]}"; do
  if [ -f "$loc" ] && [ -x "$loc" ]; then APP="$loc"; break; fi
done
if [ -z "$APP" ]; then
  APP=$(which tradingview 2>/dev/null || which TradingView 2>/dev/null)
fi
if [ -z "$APP" ] || [ ! -x "$APP" ]; then
  echo "tradingview-launch: could not find TradingView Desktop executable" >&2
  exit 1
fi

echo "tradingview-launch: starting $APP --remote-debugging-port=$PORT"
"$APP" --remote-debugging-port="$PORT" &
TV_PID=$!

# Background watchdog: if CDP hasn't come up in WATCHDOG_TIMEOUT seconds,
# kill any xdg-settings/xdg-mime/ktraderclient5 descendants of $TV_PID.
(
  for _ in $(seq 1 "$WATCHDOG_TIMEOUT"); do
    if curl -sS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
      exit 0
    fi
    sleep 1
  done
  echo "tradingview-launch: watchdog — CDP not up after ${WATCHDOG_TIMEOUT}s, checking for a stuck xdg-settings/ktraderclient5 child" >&2
  STUCK_PIDS=$(pgrep -f "xdg-settings|xdg-mime|ktraderclient" || true)
  if [ -n "$STUCK_PIDS" ]; then
    echo "tradingview-launch: watchdog — killing stuck PIDs: $STUCK_PIDS" >&2
    kill -9 $STUCK_PIDS 2>/dev/null || true
  fi
) &

# Foreground: keep the launcher itself alive as long as the TradingView
# process is, so systemd (Type=simple) supervises the real process, not
# a shell that exits immediately.
wait "$TV_PID"
