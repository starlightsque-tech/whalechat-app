# Install WhaleChat on a device or emulator (ADB)

## Prerequisites
- Android platform-tools (`adb`)
- A connected phone with USB debugging enabled, or an Android emulator
- The signed APK, e.g. `whalechat-release.apk` or a build from `.github/workflows/build-android-apk.yml`

## Install on a real device
```bash
adb devices -l
./scripts/adb-install-apk.sh whalechat-release.apk whalechat-device.png
```
The script installs the APK, launches `app.whalechat.mobile`, waits for the web shell and writes a screenshot.

## Install on an emulator
```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
./scripts/android-emulator.sh whalechat-release.apk whalechat-emulator.png
```

## Manual commands
```bash
adb install -r -d whalechat-release.apk
adb shell monkey -p app.whalechat.mobile -c android.intent.category.LAUNCHER 1
adb exec-out screencap -p > proof.png
```

## CI proof
`.github/workflows/android-emulator-smoke.yml` runs the APK on a headless Android emulator, launches it, captures `whalechat-emulator.png` and uploads it as a workflow artifact.
