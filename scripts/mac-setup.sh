#!/usr/bin/env bash
# Understage — one-time (re-runnable) Mac setup for building on a real iPhone with local Xcode.
# Usage: npm run mac:setup            (or: bash scripts/mac-setup.sh [--clean] [--help])
#   --clean        regenerate ios/ with `expo prebuild --clean` (use after changing app.json / IOS_BUNDLE_ID)
#   --force-xcode  continue with Xcode 26.0–26.3 (below Expo's 26.4 minimum; experimental, builds from source)
# Env: XCODE_APP=/path/to/Xcode.app  use this Xcode (default: newest /Applications/Xcode*.app)
set -Eeuo pipefail
# shellcheck source=mac-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/mac-common.sh"

CLEAN=0; FORCE_XCODE=0
[[ "${UNDERSTAGE_ALLOW_OLD_XCODE:-0}" == 1 ]] && FORCE_XCODE=1
for a in "$@"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    --force-xcode) FORCE_XCODE=1 ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Unknown option: $a (try --help)" ;;
  esac
done
on_err() { [[ -n "${_ERR_SHOWN:-}" ]] && return; _ERR_SHOWN=1; printf '\n%s✖ Setup stopped (line %s, exit %s). Read the message above, fix it, then re-run: npm run mac:setup%s\n' "$C_RED" "$1" "$2" "$C_OFF" >&2; }
trap 'on_err "$LINENO" "$?"' ERR

DONE=()
note() { DONE+=("$1"); }

# ---------------------------------------------------------------- 1. macOS
step "1/10 Checking your Mac"
[[ "$(uname -s)" == "Darwin" ]] || die "This script must run on macOS (found $(uname -s))."
MACOS="$(sw_vers -productVersion)"; ARCH="$(uname -m)"
ok "macOS $MACOS on $ARCH ($(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo cpu))"
note "macOS $MACOS ($ARCH)"

# ---------------------------------------------------------------- 2. Node
step "2/10 Node.js $NODE_MAJOR (≥ $MIN_NODE)"
if ! find_node; then
  other="$(command -v node 2>/dev/null || true)"
  [[ -n "$other" ]] && info "Found $("$other" -v) at $other — Expo SDK 58 is tested on Node 22 LTS, so a separate Node 22 is used for this project (your other Node is left untouched)."
  install_node22; find_node || die "Node $NODE_MAJOR install in $NODE22_DIR didn't work."
fi
ok "Node $(node -v) at $NODE_BIN, npm $(npm -v)  (used only by these scripts and the Xcode build)"
note "Node $(node -v) ($NODE_BIN)"

# ---------------------------------------------------------------- 3. Xcode
step "3/10 Finding Xcode ≥ $MIN_XCODE"
XC="" XCV=0
if [[ -n "${XCODE_APP:-}" ]]; then XC="$XCODE_APP"; XCV="$(xcode_version "$XC")"
elif line="$(find_newest_xcode)"; then XCV="${line%%$'\t'*}"; XC="${line#*$'\t'}"; fi
[[ -n "$XC" && -d "$XC" ]] || die "Xcode not found in /Applications (Xcode*.app) or ~/Downloads. Install Xcode."
if [[ "$XC" == "$HOME/Downloads/"* ]]; then warn "Xcode is in ~/Downloads. Moving it to /Applications is recommended (drag it in Finder)."; fi
ok "Found Xcode $XCV at $XC"
OLD_XCODE=0
if ! version_ge "$XCV" "$MIN_XCODE"; then
  OLD_XCODE=1
  if ! version_ge "$XCV" "$MIN_XCODE_FORCE"; then
    cat >&2 <<MSG

${C_RED}${C_BLD}Xcode $XCV can't build this project.${C_OFF}
  Expo SDK 58 / React Native 0.88 sources use the iOS 26 SDK and Swift 6.2 (swift-tools-version 6.2,
  unguarded iOS 26 APIs in expo-image-picker / expo-notifications). Xcode 16.x ships iOS 18 SDK / Swift 6.1.
  Expo's supported minimum is ${C_BLD}Xcode $MIN_XCODE${C_OFF} (https://docs.expo.dev/versions/v58.0.0/).

  On macOS $MACOS ($(sysctl -n hw.model 2>/dev/null || echo unknown)):
   • Xcode 26.4+ needs macOS Tahoe 26.2+. If your Mac can't run Tahoe, the newest Xcode it can run is 26.3
     (macOS 15.6+). Download "Xcode 26.3" from https://developer.apple.com/download/all/ (free Apple ID),
     put it in /Applications (any name like Xcode-26.3.app works), then run:
       ${C_BLD}npm run mac:setup -- --force-xcode${C_OFF}   (experimental — below Expo's supported minimum)
MSG
    exit 2
  fi
  cat >&2 <<MSG

${C_YEL}${C_BLD}Xcode $XCV is below Expo SDK 58's supported minimum ($MIN_XCODE).${C_OFF}
  Precompiled Expo modules are built with Swift 6.3.1 (Xcode 26.4) and can't be used, so this setup
  builds every Expo module from source with your Swift 6.2 (slower first build). Expo does not test this;
  a compile error in an Expo module is possible (see github.com/expo/expo/issues/47539 for SDK 57).
  The reliable fix is Xcode 26.4+ (needs macOS Tahoe 26.2+).
MSG
  if ((FORCE_XCODE == 0)); then
    printf '
  To try anyway:  %snpm run mac:setup -- --force-xcode%s
' "$C_BLD" "$C_OFF" >&2; exit 2
  fi
  warn "Continuing with Xcode $XCV because of --force-xcode (experimental)"
  export EXPO_USE_PRECOMPILED_MODULES=0
fi

DEV_DIR="$XC/Contents/Developer"
CUR="$(xcode-select -p 2>/dev/null || true)"
if [[ "$CUR" != "$DEV_DIR" ]]; then
  warn "xcode-select points at '${CUR:-nothing}', not $DEV_DIR."
  info "Running: sudo xcode-select -s \"$DEV_DIR\""
  info "macOS will ask for ${C_BLD}your Mac login password${C_OFF} (nothing shows while you type). Ctrl-C to skip."
  if sudo xcode-select -s "$DEV_DIR"; then ok "xcode-select now uses $DEV_DIR"
  else warn "Couldn't switch xcode-select; using DEVELOPER_DIR for this session instead."; export DEVELOPER_DIR="$DEV_DIR"; fi
else ok "xcode-select → $DEV_DIR"; fi

if ! xcodebuild -license check >/dev/null 2>&1; then
  info "Accepting the Xcode licence: sudo xcodebuild -license accept (password prompt)"
  sudo xcodebuild -license accept || die "Couldn't accept the Xcode licence. Open Xcode once and click Agree, then re-run."
fi
ok "Xcode licence accepted"
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  info "Installing Xcode's extra components: sudo xcodebuild -runFirstLaunch (password prompt)"
  sudo xcodebuild -runFirstLaunch || die "xcodebuild -runFirstLaunch failed. Open Xcode once, let it install components, then re-run."
fi
ok "Xcode components installed"
note "Xcode $XCV ($XC)"

# ---------------------------------------------------------------- 4. iOS platform
step "4/10 Checking the iOS SDK / platform"
if xcodebuild -showsdks 2>/dev/null | grep -q -- '-sdk iphoneos'; then ok "iOS SDK: $(xcodebuild -showsdks | grep -- '-sdk iphoneos' | head -1 | xargs)"
else
  info "iOS platform missing — downloading it (several GB; this can take a while): xcodebuild -downloadPlatform iOS"
  xcodebuild -downloadPlatform iOS || die "Couldn't download the iOS platform. In Xcode: Settings → Components → iOS → Get, then re-run."
  ok "iOS platform installed"
fi
note "iOS SDK present"

# ---------------------------------------------------------------- 5. CocoaPods
step "5/10 CocoaPods"
add_gem_bin_to_path
if command -v pod >/dev/null 2>&1; then ok "CocoaPods $(pod --version) at $(command -v pod)"
elif command -v brew >/dev/null 2>&1; then
  info "Installing CocoaPods with Homebrew"; brew install cocoapods
else
  command -v ruby >/dev/null 2>&1 || die "Ruby not found (macOS normally ships /usr/bin/ruby). Install Homebrew and run: brew install cocoapods"
  RUBYV="$(ruby -e 'print RUBY_VERSION')"
  info "Installing CocoaPods for your user with the system Ruby $RUBYV (no sudo needed)."
  if version_ge "$RUBYV" 3.0; then
    gem install --user-install --no-document cocoapods
  else
    # System Ruby 2.6 can't install today's CocoaPods dependency tree; pin versions that still support Ruby 2.6.
    info "Ruby $RUBYV is old — installing a pinned, Ruby-2.6-compatible CocoaPods 1.15.2 set (takes a few minutes)."
    pins=( "ffi:1.16.3" "public_suffix:4.0.7" "addressable:2.8.7" "concurrent-ruby:1.3.4" "i18n:1.14.6"
           "minitest:5.25.4" "zeitwerk:2.6.18" "tzinfo:2.0.6" "activesupport:6.1.7.10" "rexml:3.3.9"
           "nkf:0.2.0" "CFPropertyList:3.0.7" "xcodeproj:1.25.1" "cocoapods:1.15.2" )
    for p in "${pins[@]}"; do
      n="${p%%:*}"; v="${p#*:}"
      if gem list -i "^${n}$" -v "$v" >/dev/null 2>&1; then continue; fi
      info "gem install $n $v"
      gem install --user-install --no-document --conservative "$n" -v "$v" \
        || die "Installing gem $n $v failed. If it mentions a compiler, run: xcode-select --install, then re-run."
    done
  fi
  add_gem_bin_to_path
  GB="$(gem_user_bin)"
  # shellcheck disable=SC2016  # literal $PATH for ~/.zshrc
  if ! grep -qsF "$GB" "$HOME/.zshrc"; then printf '\nexport PATH="%s:$PATH"   # CocoaPods (gem --user-install)\n' "$GB" >>"$HOME/.zshrc"; info "Added $GB to ~/.zshrc"; fi
  command -v pod >/dev/null 2>&1 || die "CocoaPods installed but 'pod' isn't on PATH. Open a new Terminal and re-run."
  ok "CocoaPods $(pod --version)"
fi
note "CocoaPods $(pod --version 2>/dev/null)"

# ---------------------------------------------------------------- 6. npm deps
step "6/10 Installing JavaScript dependencies"
npm_install() { (cd "$1" && { npm ci --no-audit --no-fund || { warn "npm ci failed in $1 — trying npm install"; npm install --no-audit --no-fund; }; }) || die "npm install failed in $1 (see the errors above; check your internet connection)."; }
npm_install "$ROOT_DIR";  ok "App dependencies installed"
npm_install "$SERVER_DIR"; ok "Server dependencies installed"
note "npm dependencies (app + server)"

# ---------------------------------------------------------------- 7. env files
step "7/10 Environment files"
[[ -f "$APP_ENV" ]] || { cp "$ROOT_DIR/.env.example" "$APP_ENV"; ok "Created .env from .env.example"; }
[[ -f "$SERVER_ENV" ]] || { cp "$SERVER_DIR/.env.example" "$SERVER_ENV"; ok "Created server/.env from server/.env.example"; }
for k in JWT_SECRET INVITE_SECRET IDENTIFIER_PEPPER; do
  v="$(env_get "$SERVER_ENV" "$k")"
  if [[ -z "$v" || "$v" == change-me* || "$v" == dev-* ]]; then env_set "$SERVER_ENV" "$k" "$(openssl rand -hex 32)"; ok "Generated a random $k"; fi
done
if IP="$(detect_ip)"; then ok "Mac LAN IP: $IP"; apply_ip_to_env "$IP" "$(server_port)"
else warn "No LAN IP found (is Wi-Fi on?). Set EXPO_PUBLIC_API_URL in .env yourself, or run npm run mac:launch later."; fi
note "App .env → $(env_get "$APP_ENV" EXPO_PUBLIC_API_URL)"

# ---------------------------------------------------------------- 8. database
step "8/10 Demo database"
DBF="$(env_get "$SERVER_ENV" DB_FILE)"; DBF="${DBF:-./understage.db}"
if [[ -f "$SERVER_DIR/$DBF" || -f "$DBF" ]]; then ok "Database exists ($DBF) — not reseeding"
else (cd "$SERVER_DIR" && SEED_RESET=0 npm run seed) || die "Seeding failed (see above)."; ok "Seeded demo data into $DBF"; fi
note "Database $DBF"

# ---------------------------------------------------------------- 9. prebuild
step "9/10 Generating the native iOS project"
cd "$ROOT_DIR"
if ((CLEAN)); then npx expo prebuild --platform ios --clean --no-install; ok "ios/ regenerated (--clean)"
elif [[ ! -d ios ]]; then npx expo prebuild --platform ios --no-install; ok "ios/ generated"
else ok "ios/ already exists (use --clean to regenerate)"; fi
write_xcode_env_local && ok "ios/.xcode.env.local → NODE_BINARY=$NODE_BIN"
if ((OLD_XCODE)); then set_precompiled_modules false; ok "Precompiled Expo modules off (Podfile.properties.json) — building from source"
else set_precompiled_modules true; fi
note "ios/ native project"

# ---------------------------------------------------------------- 10. pods
step "10/10 pod install"
(cd ios && { pod install || { warn "pod install failed — retrying with --repo-update"; pod install --repo-update; }; }) \
  || die "pod install failed. Try: npm run mac:setup -- --clean"
ok "Pods installed"
note "Pods installed"

trap - ERR
printf '\n%s%s✔ Setup complete%s\n' "$C_GRN" "$C_BLD" "$C_OFF"
for d in "${DONE[@]}"; do printf '  %s✔%s %s\n' "$C_GRN" "$C_OFF" "$d"; done
cat <<EOF2

Next:
  1. Plug in your iPhone with USB, unlock it, tap "Trust This Computer".
  2. iPhone: Settings → Privacy & Security → Developer Mode → On (restart).
  3. Run:  ${C_BLD}npm run mac:launch${C_OFF}
EOF2
