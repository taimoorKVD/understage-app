#!/usr/bin/env bash
# Shared helpers for mac-setup.sh / mac-launch.sh. Sourced, not run directly.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BLD=''; C_OFF=''
fi
step() { printf '\n%s==> %s%s\n' "$C_BLU$C_BLD" "$*" "$C_OFF"; }
ok()   { printf '%s  ✔ %s%s\n' "$C_GRN" "$*" "$C_OFF"; }
warn() { printf '%s  ! %s%s\n' "$C_YEL" "$*" "$C_OFF"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n%s✖ %s%s\n' "$C_RED$C_BLD" "$*" "$C_OFF" >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
APP_ENV="$ROOT_DIR/.env"
SERVER_ENV="$SERVER_DIR/.env"
AUTO_MARK='# understage:auto-ip (managed by scripts/mac-*.sh; delete this line to pin your own URL)'
PLACEHOLDER_URL='http://192.168.1.20:4000'
MIN_NODE='22.13.0'    # Expo SDK 58 minimum
MIN_XCODE='26.4'      # Expo SDK 58 supported minimum (docs.expo.dev/versions/v58.0.0)
MIN_XCODE_FORCE='26.0' # below this the iOS 26 SDK / Swift 6.2 the sources need is missing: never builds
NODE_MAJOR='22'       # pin: Expo SDK 58 supports Node 22.13+ LTS; Node 26 is not in Expo's tested range
NODE22_DIR="$HOME/.local/node22"   # where we download Node 22 if no install is found

# version_ge A B  -> true if A >= B (dotted numeric)
version_ge() {
  local IFS=.; local -a a b; read -r -a a <<<"$1"; read -r -a b <<<"$2"; local i
  for i in 0 1 2 3; do
    local x=${a[i]:-0} y=${b[i]:-0}; x=${x//[!0-9]/}; y=${y//[!0-9]/}; x=${x:-0}; y=${y:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# Node 22 (>= MIN_NODE, major NODE_MAJOR) on PATH for this script only. Searches, in order:
# ~/.local/node22, ~/.local/node, current PATH, Homebrew node@22, nvm, fnm, volta. Never touches other installs.
node_ok() { local v; v="$("$1" -v 2>/dev/null | tr -d v)" || return 1; [[ "${v%%.*}" == "$NODE_MAJOR" ]] && version_ge "$v" "$MIN_NODE"; }
find_node() {
  local d cands=("$NODE22_DIR/bin" "$HOME/.local/node/bin")
  local cur; cur="$(command -v node 2>/dev/null || true)"; [[ -n "$cur" ]] && cands+=("$(dirname "$cur")")
  cands+=(/usr/local/opt/node@22/bin /opt/homebrew/opt/node@22/bin)
  shopt -s nullglob
  # newest first (reverse glob order)
  local extra=("$HOME"/.nvm/versions/node/v22.*/bin
               "$HOME"/.local/share/fnm/node-versions/v22.*/installation/bin
               "$HOME/Library/Application Support/fnm/node-versions"/v22.*/installation/bin
               "$HOME"/.fnm/node-versions/v22.*/installation/bin
               "$HOME"/.volta/tools/image/node/22.*/bin)
  shopt -u nullglob
  local i; for ((i=${#extra[@]}-1; i>=0; i--)); do cands+=("${extra[i]}"); done
  for d in "${cands[@]}"; do
    if [[ -x "$d/node" ]] && node_ok "$d/node"; then
      [[ ":$PATH:" == ":$d:"* ]] || PATH="$d:$PATH"; export PATH; NODE_BIN="$d/node"; export NODE_BIN; return 0
    fi
  done
  return 1
}
# Download the latest Node 22 LTS from nodejs.org into ~/.local/node22 (checksum-verified, no sudo).
install_node22() {
  local arch tmp base file sum
  case "$(uname -m)" in x86_64) arch=x64 ;; arm64) arch=arm64 ;; *) die "Unsupported CPU $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "Couldn't reach nodejs.org to download Node $NODE_MAJOR."
  file="$(awk -v a="darwin-$arch.tar.gz" '$2 ~ a"$" {print $2; exit}' "$tmp/SHASUMS256.txt")"
  [[ -n "$file" ]] || die "No Node $NODE_MAJOR macOS $arch build listed at $base"
  info "Downloading $file → $NODE22_DIR"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || die "Node download failed."
  sum="$(awk -v f="$file" '$2==f {print $1}' "$tmp/SHASUMS256.txt")"
  [[ "$(shasum -a 256 "$tmp/$file" | awk '{print $1}')" == "$sum" ]] || die "Node download checksum mismatch — not installing."
  rm -rf "$NODE22_DIR.tmp"; mkdir -p "$NODE22_DIR.tmp"
  tar xzf "$tmp/$file" -C "$NODE22_DIR.tmp" --strip-components 1
  rm -rf "$NODE22_DIR"; mv "$NODE22_DIR.tmp" "$NODE22_DIR"; rm -rf "$tmp"
}

# Xcode helpers. Accepts any /Applications/Xcode*.app (Xcode.app, Xcode-26.3.app, Xcode_26.4.app, Xcode-beta.app).
xcode_version() { defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo 0; }
find_newest_xcode() { # prints "<version>\t<path>" of the newest Xcode found
  local app v best="" bv=0
  shopt -s nullglob
  for app in /Applications/Xcode*.app "$HOME/Applications"/Xcode*.app "$HOME/Downloads"/Xcode*.app; do
    v="$(xcode_version "$app")"; if [[ "$v" != 0 ]] && version_ge "$v" "$bv"; then best="$app"; bv="$v"; fi
  done
  shopt -u nullglob
  [[ -n "$best" ]] && printf '%s\t%s\n' "$bv" "$best"
}
# Point Xcode's "Bundle React Native code" phase at our Node 22 (ios/.xcode.env.local is git-ignored by Expo).
write_xcode_env_local() {
  [[ -d "$ROOT_DIR/ios" && -n "${NODE_BIN:-}" ]] || return 0
  printf 'export NODE_BINARY="%s"\n' "$NODE_BIN" >"$ROOT_DIR/ios/.xcode.env.local"
}
# Xcode < MIN_XCODE (26.0–26.3): build every Expo module from source; the precompiled XCFrameworks in
# expo-modules-core are built with Swift 6.3.1 (Xcode 26.4) and can't be loaded by Swift 6.2.
set_precompiled_modules() { # $1 = true|false
  local f="$ROOT_DIR/ios/Podfile.properties.json"; [[ -f "$f" ]] || return 0
  node -e 'const fs=require("fs"),f=process.argv[1],v=process.argv[2];const j=JSON.parse(fs.readFileSync(f,"utf8"));
    if(v==="true")delete j.EXPO_USE_PRECOMPILED_MODULES;else j.EXPO_USE_PRECOMPILED_MODULES="false";
    fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$f" "$1"
}

# Ruby user gem bin dir (CocoaPods installed with --user-install lands here)
gem_user_bin() {
  command -v ruby >/dev/null 2>&1 || return 0
  local d; d="$(ruby -e 'print Gem.user_dir' 2>/dev/null || true)"
  if [[ -n "$d" ]]; then echo "$d/bin"; fi
}
add_gem_bin_to_path() {
  local b; b="$(gem_user_bin)"
  if [[ -n "$b" && -d "$b" && ":$PATH:" != *":$b:"* ]]; then PATH="$b:$PATH"; export PATH; fi
}

# Detect the Mac's LAN IP: en0, en1, then the default-route interface.
detect_ip() {
  local ip="" ifc
  for ifc in en0 en1; do ip="$(ipconfig getifaddr "$ifc" 2>/dev/null || true)"; [[ -n "$ip" ]] && { echo "$ip"; return 0; }; done
  ifc="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
  [[ -n "$ifc" ]] && ip="$(ipconfig getifaddr "$ifc" 2>/dev/null || true)"
  [[ -n "$ip" ]] && { echo "$ip"; return 0; }
  return 1
}

# env_get FILE KEY  -> value (unquoted) or empty
env_get() { [[ -f "$1" ]] || return 0; sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

# env_set FILE KEY VALUE [MARK]  -> replace the active KEY= line (and its preceding auto marker) or append
env_set() {
  local file=$1 key=$2 val=$3 mark=${4:-} tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" -v m="$mark" -v am="$AUTO_MARK" '
    BEGIN { done = 0 }
    $0 == am { held = $0; next }
    $0 ~ "^[[:space:]]*" k "[[:space:]]*=" {
      if (!done) { if (m != "") print m; print k "=" v; done = 1 }
      held = ""; next
    }
    { if (held != "") { print held; held = "" } print }
    END { if (held != "") print held; if (!done) { if (m != "") print m; print k "=" v } }
  ' "$file" >"$tmp" && cat "$tmp" >"$file" && rm -f "$tmp"
}

# is_auto FILE KEY -> true if KEY is unset/placeholder or was written by these scripts
is_auto_value() {
  local file=$1 key=$2 v
  v="$(env_get "$file" "$key")"
  [[ -z "$v" || "$v" == "$PLACEHOLDER_URL" ]] && return 0
  grep -B1 -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | grep -qF "$AUTO_MARK"
}

# Point EXPO_PUBLIC_API_URL / EXPO_PUBLIC_SOCKET_URL at http://IP:PORT unless the user pinned their own value.
apply_ip_to_env() {
  local ip=$1 port=$2 url="http://$1:$2" key changed=0
  for key in EXPO_PUBLIC_API_URL EXPO_PUBLIC_SOCKET_URL; do
    if is_auto_value "$APP_ENV" "$key"; then
      if [[ "$(env_get "$APP_ENV" "$key")" != "$url" ]]; then env_set "$APP_ENV" "$key" "$url" "$AUTO_MARK"; changed=1; fi
    else
      warn "$key is set by you to $(env_get "$APP_ENV" "$key") — leaving it unchanged"
    fi
  done
  if ((changed)); then ok "App .env now points at $url"; else ok "App .env already points at $(env_get "$APP_ENV" EXPO_PUBLIC_API_URL)"; fi
}

server_port() { local p; p="$(env_get "$SERVER_ENV" PORT)"; echo "${p:-4000}"; }
