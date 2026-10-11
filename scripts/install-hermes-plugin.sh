#!/bin/sh
# Install (or update) the Orchid visualizer plugin for the Hermes of the user
# who runs this script, and point it at the visualizer.
#
#   scripts/install-hermes-plugin.sh                 install / update, enable, check the connection
#   scripts/install-hermes-plugin.sh --url URL       visualizer hook URL (default http://127.0.0.1:4747/hermes/hook)
#   scripts/install-hermes-plugin.sh --home DIR      Hermes home (default $HERMES_HOME, else ~/.hermes)
#   scripts/install-hermes-plugin.sh --restart-gateway   also restart this user's messaging gateway
#   scripts/install-hermes-plugin.sh --uninstall     disable and remove the plugin
#   scripts/install-hermes-plugin.sh --dry-run       show what would happen, change nothing
#
# Run it as each macOS user that runs Hermes (e.g. `sudo -u demo -i` first). It
# only touches <Hermes home>/plugins/orchid_viz and the plugin's enabled flag
# (through `hermes plugins enable`); no other Hermes settings. Safe to re-run.
#
# The plugin observes Hermes and POSTs to the visualizer on this machine: live
# stream deltas, per-request timing, finished messages (the reasoning trace) and
# Hermes' own inference statistics. The visualizer redacts secrets before display.
set -eu

URL="http://127.0.0.1:4747/hermes/hook"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
ACTION=install
DRY=0
RESTART_GW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --uninstall) ACTION=uninstall; shift ;;
    --dry-run) DRY=1; shift ;;
    --restart-gateway) RESTART_GW=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$0")/.." && pwd)/hermes-plugin/orchid_viz"
DEST="$HOME_DIR/plugins/orchid_viz"
USER_NAME="$(id -un)"
say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "Orchid visualizer plugin · user $USER_NAME · Hermes home $HOME_DIR"
REAL_HOME="$(cd "$HOME_DIR" 2>/dev/null && pwd -P || true)"
[ -n "$REAL_HOME" ] || fail "no Hermes home at $HOME_DIR (run Hermes once, or pass --home)"
[ "$REAL_HOME" = "$HOME_DIR" ] || say "  ($HOME_DIR → $REAL_HOME)"
HERMES="$(command -v hermes || true)"
[ -n "$HERMES" ] || warn "hermes is not on PATH for $USER_NAME: the plugin will be copied, but enable it yourself with: hermes plugins enable orchid_viz"

if [ "$ACTION" = uninstall ]; then
  [ -n "$HERMES" ] && run "$HERMES" plugins disable orchid_viz || true
  run rm -rf "$DEST"
  ok "removed $DEST"
  say "Restart this user's Hermes CLI (and gateway) to unload it."
  exit 0
fi

[ -f "$SRC/__init__.py" ] || fail "plugin source not found at $SRC"
mkdir_ok=1
if [ "$DRY" = 0 ]; then
  mkdir -p "$HOME_DIR/plugins" 2>/dev/null || mkdir_ok=0
  [ -w "$HOME_DIR/plugins" ] || mkdir_ok=0
fi
[ "$mkdir_ok" = 1 ] || fail "$USER_NAME can't write $HOME_DIR/plugins (that Hermes home belongs to another user?). Run this as the owner of $HOME_DIR, or give $USER_NAME its own Hermes home."

# 1. Copy the plugin. (No backup copy inside plugins/: Hermes would load it as a second plugin.
#    The source lives in this repository.)
VERSION="$(sed -n 's/^version: *//p' "$SRC/plugin.yaml")"
if [ -d "$DEST" ]; then
  OLD="$(sed -n 's/^version: *//p' "$DEST/plugin.yaml" 2>/dev/null || true)"
  say "  replacing installed version ${OLD:-?}"
  run rm -rf "$DEST"
fi
run mkdir -p "$DEST"
run cp "$SRC/__init__.py" "$SRC/plugin.yaml" "$DEST/"
if [ "$DRY" = 1 ]; then say "  would write $DEST/config.json → $URL"; else printf '{"url": "%s"}\n' "$URL" > "$DEST/config.json"; fi
ok "installed orchid_viz $VERSION → $DEST (sends to $URL)"

# 2. Enable it, the supported way (no tool overrides: it is an observer).
if [ -n "$HERMES" ]; then
  if [ "$DRY" = 1 ]; then say "  would run: $HERMES plugins enable orchid_viz --no-allow-tool-override"
  elif "$HERMES" plugins enable orchid_viz --no-allow-tool-override >/dev/null 2>&1; then ok "enabled in Hermes"
  else warn "couldn't enable automatically: run  hermes plugins enable orchid_viz"; fi
fi

# 3. Check the visualizer is reachable from this user (it must be running).
if [ "$DRY" = 0 ] && command -v curl >/dev/null 2>&1; then
  BODY="[{\"type\":\"hello\",\"user\":\"$USER_NAME\",\"home\":\"$REAL_HOME\",\"plugin\":\"$VERSION (installer check)\",\"t\":$(date +%s)}]"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'content-type: application/json' --data "$BODY" "$URL" || true)"
  if [ "$CODE" = 204 ]; then ok "visualizer reachable at $URL (shows on its status page under Hermes Agent)"
  else warn "visualizer not answering at $URL (HTTP ${CODE:-none}). Start it (npm start in the orchid-visualization folder); the plugin connects on its own once it is up."; fi
fi

# 4. Load it.
if [ "$RESTART_GW" = 1 ] && [ -n "$HERMES" ]; then run "$HERMES" gateway restart && ok "gateway restarted"; fi
say ""
say "Next: restart $USER_NAME's Hermes CLI (exit and start it again) so the plugin loads."
[ "$RESTART_GW" = 1 ] || say "      For WhatsApp, also: hermes gateway restart   (or re-run with --restart-gateway)"
say "Check: the visualizer's Status page → Hermes Agent → Visualizer stream hook lists $USER_NAME."
