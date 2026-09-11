# Setup Guide for Claude Code

This file is a step-by-step guide for Claude Code (or any LLM agent) to install and configure the TradingView MCP server. If a user asks you to install or set up this project, follow these steps exactly.

## Step 1: Clone and Install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

If the user specifies a different install path, use that instead of `~/tradingview-mcp`.

## Step 2: Add to MCP Config

Add the server to the user's Claude Code MCP configuration. The config file is at `~/.claude/.mcp.json` (global) or `.mcp.json` (project-level).

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["<INSTALL_PATH>/src/server.js"]
    }
  }
}
```

Replace `<INSTALL_PATH>` with the actual path where the repo was cloned (e.g., `/Users/username/tradingview-mcp`).

If the config file already exists and has other servers, merge the `tradingview` entry into the existing `mcpServers` object. Do not overwrite other servers.

## Step 3: Launch TradingView Desktop

TradingView Desktop must be running with Chrome DevTools Protocol enabled.

**Auto-detect and launch (recommended):**
After the MCP server is connected, use the `tv_launch` tool — it auto-detects TradingView on Mac, Windows, and Linux.

**Manual launch by platform:**

Mac:
```bash
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

Windows:

TradingView for Windows now ships **only as an MSIX package** (Microsoft Store and tvd-packages.tradingview.com both install under `C:\Program Files\WindowsApps\`). Use the launch script — it resolves the install via `Get-AppxPackage`, which works without admin rights:

```bat
scripts\launch_tv_debug.bat
```

Or, preferred: let the `tv_launch` MCP tool do it — it auto-detects MSIX installs and, on Windows builds where launching from `WindowsApps` is blocked with **"Access is denied"**, automatically copies the package to `%LOCALAPPDATA%\tradingview-mcp\` (one-time, ~330MB) and launches from the copy. The copy keeps your login, layout, and chart state. If the fallback was used, the result includes `msix_local_copy: true`.

Manual equivalent of that fallback, if you need it:

```powershell
$pkg = (Get-AppxPackage TradingView.Desktop).InstallLocation
Copy-Item "$pkg\*" "$env:LOCALAPPDATA\tradingview-mcp\TradingView" -Recurse -Force
& "$env:LOCALAPPDATA\tradingview-mcp\TradingView\TradingView.exe" --remote-debugging-port=9222
```

Reading files out of `WindowsApps` by exact path is allowed even where executing them isn't. Do **not** try to change ACLs on `WindowsApps` with `icacls` — it fails and can break app servicing.

Legacy (pre-MSIX) installs:
```bash
%LOCALAPPDATA%\TradingView\TradingView.exe --remote-debugging-port=9222
```

Linux:
```bash
/opt/TradingView/tradingview --remote-debugging-port=9222
# or: tradingview --remote-debugging-port=9222
```

## Step 4: Restart Claude Code

The MCP server only loads when Claude Code starts. After adding the config:

1. Exit Claude Code (Ctrl+C)
2. Relaunch Claude Code
3. The tradingview MCP server should connect automatically

## Step 5: Verify Connection

Use the `tv_health_check` tool. Expected response:

```json
{
  "success": true,
  "cdp_connected": true,
  "chart_symbol": "...",
  "api_available": true
}
```

If `cdp_connected: false`, TradingView is not running with `--remote-debugging-port=9222`.

## Step 6: Install CLI (Optional)

To use the `tv` CLI command globally:

```bash
cd ~/tradingview-mcp
npm link
```

Then `tv status`, `tv quote`, `tv pine compile`, etc. work from anywhere.

## Always-On Setup (Linux, systemd) — Optional

By default the MCP server is spawned per Claude session (stdio transport) and TradingView Desktop must be launched manually or via `tv_launch`. For a machine that should have TradingView + the MCP bridge already running and reachable the moment Claude starts — e.g. this desktop, which also bridges a Jetson pipeline builder over a direct Ethernet link — run the server as an always-on **Streamable HTTP** service instead, with TradingView Desktop auto-started on login.

### 1. Install the systemd --user units

```bash
cd ~/tradingview-mcp
./scripts/systemd/install.sh
```

This copies `tradingview-cdp.service` and `tradingview-mcp-http.service` into `~/.config/systemd/user/` and reloads the daemon, but does **not** enable or start them yet — review the unit files first (they assume the repo lives at `~/tradingview-mcp`; edit the `ExecStart` paths if yours is elsewhere).

### 2. Enable and start

```bash
systemctl --user enable --now tradingview-cdp.service tradingview-mcp-http.service
```

Or run `./scripts/systemd/install.sh --enable` to do both steps at once.

### 3. Point Claude at the URL instead of a command

Claude Code CLI:
```bash
claude mcp add --transport http tradingview http://127.0.0.1:8787/mcp
```

Or in `.mcp.json` / Claude Desktop config, use `url` instead of `command`/`args`:
```json
{
  "mcpServers": {
    "tradingview": { "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

### Known caveat: KDE `xdg-settings` hang

On at least one KDE Plasma machine, TradingView's own startup synchronously calls `xdg-settings set default-url-scheme-handler` to register its URL scheme, which shells out to KDE's `ktraderclient5` — and that call has been observed to hang **indefinitely** (not slow — genuinely never returns), blocking TradingView's own startup and CDP from ever coming up. `launch_tv_service.sh` includes a watchdog: if CDP isn't reachable within `TV_LAUNCH_WATCHDOG_S` seconds (default 20), it kills any stuck `xdg-settings`/`xdg-mime`/`ktraderclient5` process and TradingView resumes immediately. If TradingView still won't launch under systemd, check `journalctl --user -u tradingview-cdp.service` for this signature.

### Security note

`server-http.js` binds to `127.0.0.1` only and refuses to start on any other host — it has no authentication. Do not put it behind a reverse proxy or expose it on a non-loopback interface without adding auth in front of it first.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| Windows: "Access is denied" launching from `WindowsApps` | Use `tv_launch` (auto copy-fallback) or the manual copy snippet in Step 3 — never `icacls` on WindowsApps |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (78 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
