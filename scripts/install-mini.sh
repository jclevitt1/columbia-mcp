#!/usr/bin/env bash
# Set columbia-mcp up on a fresh machine (the Mac Mini).
#
#   ./scripts/install-mini.sh          check + install, print the plist
#   ./scripts/install-mini.sh --load   also install and start the LaunchAgent
#
# Deliberately does NOT create .env. Secrets are gitignored and must be copied
# across by hand — see the hint printed below if it's missing.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="dev.jclevitt.columbia-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; }

echo "columbia-mcp install — $ROOT"
echo
echo "Prerequisites"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  bad "node not found — install it (brew install node) and re-run"; exit 1
fi
ok "node $($NODE_BIN --version) at $NODE_BIN"

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  bad "claude not found — install Claude Code, then run 'claude' once to log in"
  echo "       The bridge shells out to it and there is no API key fallback."
  exit 1
fi
ok "claude $($CLAUDE_BIN --version 2>/dev/null | head -1) at $CLAUDE_BIN"

echo
echo "Dependencies"
npm install --silent && ok "npm packages"
npx --yes playwright install chromium >/dev/null 2>&1 && ok "chromium for Playwright"

echo
echo "Configuration"
if [ ! -f .env ]; then
  bad ".env missing — it is gitignored, so the clone did not bring it"
  echo
  echo "       Copy it from the machine you set this up on:"
  echo "         scp <laptop>:~/workspace/Columbia/columbia-mcp/.env $ROOT/.env"
  echo "       Then re-run this script."
  exit 1
fi
chmod 600 .env
ok ".env present"

echo
echo "Health"
npm run --silent doctor || true

# Generate the LaunchAgent against THIS machine's paths rather than shipping a
# plist with someone else's node location baked in.
echo
echo "LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.columbia-mcp/logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/src/bridge/telegram.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BRIDGE_SUPERVISOR</key><string>launchd</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.columbia-mcp/logs/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.columbia-mcp/logs/bridge.err.log</string>
</dict>
</plist>
PLISTEOF
ok "wrote $PLIST"

if [ "${1:-}" = "--load" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  ok "LaunchAgent loaded — bridge starts now and on every login"
else
  echo "       Not loaded. To start it:"
  echo "         launchctl load -w $PLIST"
fi

cat <<'NOTE'

Remaining, and both need you at the machine:
  npm run vergil-login    sign in through CAS/Duo once (catalog search works without it)
  claude                  run once if you have not logged Claude Code in on this machine

Before starting here, stop the bridge on the old machine:
  pkill -f "node .*src/bridge/telegram.js"
Telegram delivers each update to exactly one poller, so two bridges on one
token silently steal each other's messages.

This is a LaunchAgent, not a Daemon — it needs your GUI session for Playwright
and Duo. Set the Mini to automatic login and prevent sleep.
NOTE
