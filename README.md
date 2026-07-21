# VeriGate Pass App

The mobile app event attendees use to display their signed, device-bound QR code for accreditation.

## 🚀 Features

- **Signed, offline QR display**: the backend issues a P-256 event/device credential; Pass signs a rotating 60-second presentation with a per-installation SecureStore key.
- **Bounded replay model**: screen-capture blocking reduces accidental sharing, but a copied presentation can be replayed during its short validity window; zero offline replay is not claimed.
- **Screen-capture protection**: `expo-screen-capture` blocks screenshots/screen recording app-wide.
- **Backgrounding protection + auto-logout**: a blur overlay covers the screen the instant the app backgrounds (`expo-blur`), and the session is force-logged-out after 5 minutes of inactivity or backgrounding.
- **Biometric login**: optional Face ID / fingerprint unlock (`expo-local-authentication`) for a remembered session, credentials held in `expo-secure-store`.
- **Live event sync**: production login authenticates against the backend and downloads only the caller's assignment-rich event projection. Blank-password local data is available only when `EXPO_PUBLIC_DEMO_MODE=true`.
- **Access-level indicator + permitted areas**: badge and detail view showing the user's access level, permitted/restricted areas, and QR validity.
- **Notifications**: local QR-expiry reminders (`expo-notifications`) always work; Android devices also register for real backend-triggered push (e.g. "your access changed") the moment a `google-services.json` is present (see below) - iOS push is implemented backend-side but gated off by default (requires a paid Apple Developer account).

## 🛠️ Tech Stack (as actually built)

This is an **Expo (SDK 53) app**, not a bare React Native CLI project:

- Expo Router (file-based navigation), TypeScript
- `expo-sqlite`'s API surface, but backed by **`@op-engineering/op-sqlite` compiled with SQLCipher** for genuine at-rest database encryption (see below) - not plain `expo-sqlite`
- `expo-secure-store` (iOS Keychain / Android Keystore) for tokens, remembered credentials, and the device's SQLCipher key
- `expo-crypto`, `expo-device`, `expo-screen-capture`, `expo-blur`, `expo-local-authentication`, `expo-notifications`

## 🔒 Local database encryption

The local database is a real SQLCipher-encrypted SQLite file (`@op-engineering/op-sqlite`). SQLCipher support is enabled via a `"op-sqlite": { "sqlcipher": true }` key in `package.json` (op-sqlite has no Expo config plugin - this key is read directly by its own `build.gradle`/`.podspec` at prebuild time), not the plaintext `expo-sqlite` default. The encryption key is a random 256-bit value generated on first run and stored only in the platform secure keystore via `expo-secure-store` - it is never hardcoded or derived from a password. On every app start the database is integrity-checked (a SHA-256 checksum of its contents is compared against the last known value); if the file fails to open or looks tampered with, the app genuinely deletes and recreates the database with a fresh key rather than reopening the same broken file. Synced event data is also purged automatically once an event's `ends_at` plus a 24h grace period has passed.

Because `op-sqlite` is a native module, **this app cannot run in Expo Go** - it requires a custom dev client or a full prebuild:

```bash
npm ci
npx expo prebuild        # generates ios/ and android/ native projects
npx expo run:android     # or: npx expo run:ios
# or, for a shareable dev client build:
eas build --profile development --platform android
```

## ⚙️ Configuration

Set `EXPO_PUBLIC_API_URL` (or `expo.extra.apiBaseUrl` in `app.json`) to your backend's `/api` URL. To enable Android push notifications, drop a free Firebase `google-services.json` into the project root before building - `app.config.js` picks it up automatically if present and is a no-op if it's absent.

## 📦 Scripts

- `npm start` — start the Expo bundler; the app itself requires a custom dev client/full native build because SQLCipher is native and is not available in Expo Go.
- `npm run android` / `npm run ios` — run on device/emulator
- `npm run prebuild` — generate native projects (required once before `expo run:*` or local EAS builds)
- `npm run build:android` / `npm run build:ios` — EAS cloud builds
- `npm run type-check` / `npm run lint` / `npm run doctor` — static validation
- `npm test` — non-watch Jest runner (no test files are committed yet)

## Future work

- iOS remote push (APNs) is fully implemented on the backend and gated behind `APNS_ENABLED=false` by default - it requires an Apple Developer Program membership. Flip the flag and configure `APNS_*` env vars on the backend to turn it on; no app-side changes are needed.
