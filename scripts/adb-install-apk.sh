#!/usr/bin/env bash
# Install the WhaleChat APK on a connected Android device/emulator and launch it.
# Usage: ./scripts/adb-install-apk.sh [path-to.apk] [screenshot.png]
set -euo pipefail

APK="${1:-whalechat-release.apk}"
SHOT="${2:-whalechat-device.png}"
PKG="app.whalechat.mobile"
ACTIVITY="app.whalechat.mobile.MainActivity"

command -v adb >/dev/null 2>&1 || { echo "adb not found. Install Android platform-tools and add it to PATH." >&2; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }

echo "Connected devices:"
adb devices -l

SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
[ -n "$SERIAL" ] || { echo "No authorised Android device/emulator connected. Start one, enable USB debugging and accept the prompt." >&2; exit 1; }

echo "Installing $APK on $SERIAL"
adb -s "$SERIAL" install -r -d "$APK"
echo "Launching $PKG/$ACTIVITY"
adb -s "$SERIAL" shell am force-stop "$PKG" || true
adb -s "$SERIAL" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 8
adb -s "$SERIAL" exec-out screencap -p > "$SHOT"
echo "Screenshot saved: $SHOT"
