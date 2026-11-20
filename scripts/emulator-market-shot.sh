#!/usr/bin/env bash
set -x
set -o pipefail
adb install -r -d "$APK_PATH"
adb shell monkey -p app.whalechat.mobile -c android.intent.category.LAUNCHER 1
sleep 10
if [ -n "$LOGIN_EMAIL" ]; then
  adb shell input tap 174 101 || true
  sleep 3
  adb exec-out screencap -p > step-login.png || true
  adb shell input tap 160 255 || true
  sleep 1
  adb shell input text "$LOGIN_EMAIL" || true
  sleep 1
  adb shell input tap 160 330 || true
  sleep 1
  adb shell input text "$LOGIN_PASSWORD" || true
  sleep 1
  adb shell input keyevent 66 || true
  sleep 12
  adb exec-out screencap -p > step-after-login.png || true
  adb shell am start -a android.intent.action.VIEW -d "https://whalechat.appwrite.network/whalechat.html${TARGET_HASH:-#/invest/market}" app.whalechat.mobile || true
  sleep 12
else
  sleep "${WAIT_SECONDS:-25}"
fi
adb exec-out screencap -p > whalechat-emulator.png
