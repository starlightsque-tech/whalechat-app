#!/usr/bin/env bash
# Create/start an Android emulator, install the WhaleChat APK and screenshot it.
# Requires Android SDK command-line tools, platform-tools and a system image.
# Usage: ./scripts/android-emulator.sh [path-to.apk] [screenshot.png]
set -euo pipefail

APK="${1:-whalechat-release.apk}"
SHOT="${2:-whalechat-emulator.png}"
AVD="${AVD_NAME:-whalechat_api30}"
API="${API_LEVEL:-30}"
IMAGE="system-images;android-${API};google_apis;x86_64"

command -v sdkmanager >/dev/null 2>&1 || { echo "sdkmanager not found. Install Android command-line tools." >&2; exit 1; }
command -v emulator >/dev/null 2>&1 || { echo "emulator not found. Install the Android emulator package." >&2; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }

yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager "platform-tools" "platforms;android-${API}" "$IMAGE" >/dev/null

if ! emulator -list-avds | grep -qx "$AVD"; then
  echo "no" | avdmanager create avd -n "$AVD" -k "$IMAGE" --device "pixel_5" --force
fi

emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel auto >/tmp/whalechat-emulator.log 2>&1 &
EMU_PID=$!
trap 'kill $EMU_PID 2>/dev/null || true' EXIT

adb wait-for-device
echo "Waiting for Android boot…"
for i in $(seq 1 90); do
  BOOT="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [ "$BOOT" = "1" ] && break
  sleep 2
done
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || { echo "Emulator did not boot." >&2; exit 1; }

./scripts/adb-install-apk.sh "$APK" "$SHOT"
echo "Emulator screenshot: $SHOT"
