#!/usr/bin/env bash
# Understage — start the backend and build/run the app on your connected iPhone (local Xcode, no cloud).
# Usage: npm run mac:launch [-- [--release] [--device "<name or UDID>"] [--no-build]]
#   --release    Release build: JS is bundled into the app, so it runs without Metro (still needs the backend)
#   --device X   pick a specific iPhone (name or UDID); otherwise Expo asks/uses the connected one
#   --no-build   only start the backend (e.g. the app is already installed)
set -euo pipefail
# shellcheck source=mac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/mac-common.sh"

RELEASE=0 DEVICE="" BUILD=1
while (($#)); do
  case "$1" in
    --release) RELEASE=1 ;;
    --device) shift; DEVICE="${1:-}"; [[ -n "$DEVICE" ]] || die "--device needs a name or UDID" ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "Run this on your Mac."
find_node || die "Node.js $MIN_NODE+ not found. Run: npm run mac:setup"
add_gem_bin_to_path
[[ -f "$APP_ENV" && -f "$SERVER_ENV" ]] || die ".env files missing. Run: npm run mac:setup"
# shellcheck disable=SC2153  # SERVER_DIR comes from mac-common.sh
[[ -d "$SERVER_DIR/node_modules" ]] || die "Server dependencies missing. Run: npm run mac:setup"
if [[ ! "$(xcode-select -p 2>/dev/null)" == /Applications/Xcode*.app/* && -z "${DEVELOPER_DIR:-}" ]] && line="$(find_newest_xcode)"; then
  export DEVELOPER_DIR="${line#*$'\t'}/Contents/Developer"
fi
XCV="$(xcodebuild -version 2>/dev/null | awk '/^Xcode/{print $2; exit}')"; XCV="${XCV:-0}"
if ! version_ge "$XCV" "$MIN_XCODE"; then
  export EXPO_USE_PRECOMPILED_MODULES=0
  warn "Xcode $XCV < $MIN_XCODE: building Expo modules from source (experimental; set up with --force-xcode)"
fi
write_xcode_env_local

step "Network"
PORT="$(server_port)"
IP="$(detect_ip)" || die "Couldn't find your Mac's IP. Connect to Wi-Fi (the same network as your iPhone)."
ok "Mac IP $IP"
apply_ip_to_env "$IP" "$PORT"

step "Backend"
mkdir -p "$ROOT_DIR/logs"; LOG="$ROOT_DIR/logs/server.log"; SERVER_PID=""
kill_tree() { # kill a process and all its descendants (npm → sh → tsx → node)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '\n'; info "Stopping backend (pid $SERVER_PID)"; kill_tree "$SERVER_PID"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  ok "A backend is already running on :$PORT — reusing it (logs are wherever you started it)"
else
  (cd "$SERVER_DIR" && exec npm start) >>"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    kill -0 "$SERVER_PID" 2>/dev/null || die "Backend exited. Last log lines:
$(tail -n 20 "$LOG")"
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || die "Backend didn't answer on :$PORT within 20s. See $LOG"
  ok "Backend running on http://$IP:$PORT (pid $SERVER_PID)"
fi
info "Server log: $LOG"
info "Dev sign-in codes: ${C_BLD}grep otp \"$LOG\"${C_OFF}  (or: tail -f \"$LOG\")"
info "iPhone check: open Safari on the phone → http://$IP:$PORT/health"

step "Connected iPhones"
if xcrun devicectl list devices 2>/dev/null | grep -Ei 'iphone|ipad' ; then :
elif xcrun xctrace list devices 2>/dev/null | sed -n '/== Devices ==/,/== Simulators ==/p' | grep -Ei 'iphone|ipad'; then :
else warn "No iPhone detected. Connect it by USB, unlock it, and tap Trust."; fi

cat <<EOF2

${C_BLD}If signing fails (first build):${C_OFF}
  1. open "$ROOT_DIR"/ios/*.xcworkspace
  2. Target "Understage" → Signing & Capabilities → tick "Automatically manage signing" → Team: your Apple ID (Personal Team)
  3. "Failed to register bundle identifier"? Add IOS_BUNDLE_ID=com.<yourname>.understage to .env,
     run: npm run mac:setup -- --clean   then run this script again.
  4. On the iPhone: Settings → General → VPN & Device Management → trust your developer certificate.
  5. Developer Mode: Settings → Privacy & Security → Developer Mode → On.
EOF2

if ((BUILD == 0)); then info "Backend is running. Press Ctrl-C to stop."; if [[ -n "$SERVER_PID" ]]; then wait "$SERVER_PID" || true; else while :; do sleep 3600; done; fi; exit 0; fi
[[ -d "$ROOT_DIR/ios" ]] || die "ios/ is missing. Run: npm run mac:setup"

step "Building and installing on your iPhone (first build takes 10–20 min)"
args=(expo run:ios --device)
[[ -n "$DEVICE" ]] && args+=("$DEVICE")
((RELEASE)) && args+=(--configuration Release)
info "npx ${args[*]}"
cd "$ROOT_DIR"
npx "${args[@]}"
if ((RELEASE)); then info "Release build installed; it runs without Metro. Keep the backend running."; info "Press Ctrl-C to stop the backend."; wait "$SERVER_PID" 2>/dev/null || true; fi
