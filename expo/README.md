# WhaleChat Expo shell (3.57.5)

Native WebView shell that loads the live Appwrite site:

**https://whalechat.appwrite.network/whalechat.html**

- EAS project: `@whalechat/whalechat` — `3f36eb52-0c8f-4635-9643-c57581ce0ceb`
- Android preview APK (build `c2d6e782`):
  https://expo.dev/accounts/whalechat/projects/whalechat/builds/c2d6e782-62d7-473f-a0b6-a2306132091e
- Artifact:
  https://expo.dev/artifacts/eas/bgU0IlZ9Q7sw1C14oYab8Jd_26jKAHiUipFer8PQlkU.apk

```bash
npm install
npx eas build -p android --profile preview
```

`EXPO_PUBLIC_WEB_URL` overrides the loaded URL at build time.
