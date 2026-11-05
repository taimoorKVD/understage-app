#!/usr/bin/env bash
# Build the understage-mls UniFFI crate into an XCFramework.
#
# From a clean clone (after rustup + the x86_64-apple-ios and
# aarch64-apple-ios targets from Phase 0):
#   ./modules/understage-mls/scripts/build-rust.sh
# then `pod install`. This script is the only supported way to produce
# ios/MlsCore.xcframework and the generated Swift bindings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST="$ROOT/rust"
IOS="$ROOT/ios"
GEN="$IOS/generated"
XC="$IOS/MlsCore.xcframework"

export PATH="${HOME}/.cargo/bin:${PATH}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.4}"

if [[ -d /Applications/Xcode-26.3.app/Contents/Developer ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-26.3.app/Contents/Developer}"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found on PATH; install rustup into \$HOME first (Phase 0)." >&2
  exit 1
fi

cd "$RUST"

echo "==> host lib + uniffi-bindgen"
cargo build --release --features bindgen --bin uniffi-bindgen

DYLIB=""
for candidate in \
  "$RUST/target/release/libunderstage_mls.dylib" \
  "$RUST/target/release/libunderstage_mls.so"
do
  if [[ -f "$candidate" ]]; then
    DYLIB="$candidate"
    break
  fi
done
if [[ -z "$DYLIB" ]]; then
  echo "host cdylib was not produced; building --lib on the host" >&2
  cargo build --release --lib
  DYLIB="$RUST/target/release/libunderstage_mls.dylib"
fi
if [[ ! -f "$DYLIB" ]]; then
  echo "missing host library at $DYLIB" >&2
  exit 1
fi

echo "==> UniFFI Swift bindings"
rm -rf "$GEN"
mkdir -p "$GEN"
"$RUST/target/release/uniffi-bindgen" generate \
  --library "$DYLIB" \
  --language swift \
  --out-dir "$GEN"

if [[ ! -f "$GEN/understage_mls.swift" ]]; then
  echo "expected $GEN/understage_mls.swift after bindgen; got:" >&2
  ls -la "$GEN" >&2
  exit 1
fi

# XCFramework headers use module.modulemap as the umbrella name.
if [[ -f "$GEN/understage_mlsFFI.modulemap" ]]; then
  cp "$GEN/understage_mlsFFI.modulemap" "$GEN/module.modulemap"
fi

build_ios_lib() {
  local target="$1"
  local sdk="$2"
  local sdkroot cc
  sdkroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  cc="$(xcrun --sdk "$sdk" --find clang)"
  echo "==> cargo build --release --target $target --lib (SDK $sdk)"
  env \
    SDKROOT="$sdkroot" \
    CC="$cc" \
    IPHONEOS_DEPLOYMENT_TARGET="$IPHONEOS_DEPLOYMENT_TARGET" \
    cargo build --release --target "$target" --lib
}

build_ios_lib x86_64-apple-ios iphonesimulator
build_ios_lib aarch64-apple-ios iphoneos

SIM_LIB="$RUST/target/x86_64-apple-ios/release/libunderstage_mls.a"
DEV_LIB="$RUST/target/aarch64-apple-ios/release/libunderstage_mls.a"
if [[ ! -f "$SIM_LIB" || ! -f "$DEV_LIB" ]]; then
  echo "missing iOS staticlibs:" >&2
  echo "  $SIM_LIB" >&2
  echo "  $DEV_LIB" >&2
  exit 1
fi

HDR_SIM="$(mktemp -d /tmp/understage-mls-hdr-sim-XXXXXX)"
HDR_DEV="$(mktemp -d /tmp/understage-mls-hdr-dev-XXXXXX)"
cleanup() { rm -rf "$HDR_SIM" "$HDR_DEV"; }
trap cleanup EXIT

for hdr in "$HDR_SIM" "$HDR_DEV"; do
  cp "$GEN/understage_mlsFFI.h" "$hdr/"
  if [[ -f "$GEN/module.modulemap" ]]; then
    cp "$GEN/module.modulemap" "$hdr/module.modulemap"
  elif [[ -f "$GEN/understage_mlsFFI.modulemap" ]]; then
    cp "$GEN/understage_mlsFFI.modulemap" "$hdr/module.modulemap"
  fi
done

echo "==> xcodebuild -create-xcframework"
rm -rf "$XC"
xcodebuild -create-xcframework \
  -library "$SIM_LIB" \
  -headers "$HDR_SIM" \
  -library "$DEV_LIB" \
  -headers "$HDR_DEV" \
  -output "$XC"

echo "==> built $XC"
ls -lh "$SIM_LIB" "$DEV_LIB"
du -sh "$XC"
echo "bindings:"
ls -la "$GEN"
