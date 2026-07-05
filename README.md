# VeriGate Pass App

The mobile app event attendees use to display their signed, device-bound QR code for accreditation.

## 🚀 Features

- **Signed, offline QR display**: SHA-256 HMAC-signed QR payload, generated and displayed fully offline.
- **Device fingerprinting**: QR payload is bound to a hashed device fingerprint (`expo-device` + `expo-crypto`).
- **Screen-capture protection**: `expo-screen-capture` blocks screenshots/screen recording app-wide.
- **Backgrounding protection + auto-logout**: a blur overlay covers the screen the instant the app backgrounds (`expo-blur`), and the session is force-logged-out after 5 minutes of inactivity or backgrounding.
- **Biometric login**: optional Face ID / fingerprint unlock (`expo-local-authentication`) for a remembered session, credentials held in `expo-secure-store`.
- **Live event sync**: logging in with a password authenticates against the backend and pulls this event's real access level + permitted areas down into the encrypted local store; leaving the password blank keeps the app fully offline on local demo data.
- **Access-level indicator + permitted areas**: badge and detail view showing the user's access level, permitted/restricted areas, and QR validity.
- **Notifications**: local QR-expiry reminders (`expo-notifications`) always work; Android devices also register for real backend-triggered push (e.g. "your access changed") the moment a `google-services.json` is present (see below) - iOS push is implemented backend-side but gated off by default (requires a paid Apple Developer account).

## 🛠️ Tech Stack (as actually built)

This is an **Expo (SDK 53) app**, not a bare React Native CLI project:

- Expo Router (file-based navigation), TypeScript
- `expo-sqlite`'s API surface, but backed by **`@op-engineering/op-sqlite` compiled with SQLCipher** for genuine at-rest database encryption (see below) - not plain `expo-sqlite`
- `expo-secure-store` (iOS Keychain / Android Keystore) for tokens, remembered credentials, and the device's SQLCipher key
- `expo-crypto`, `expo-device`, `expo-screen-capture`, `expo-blur`, `expo-local-authentication`, `expo-notifications`

## 🔒 Local database encryption

The local database is a real SQLCipher-encrypted SQLite file (`@op-engineering/op-sqlite`, `sqlCipher: true` config plugin), not the plaintext `expo-sqlite` default. The encryption key is a random 256-bit value generated on first run and stored only in the platform secure keystore via `expo-secure-store` - it is never hardcoded or derived from a password. On every app start the database is integrity-checked (a SHA-256 checksum of its contents is compared against the last known value); if the file fails to open or looks tampered with, the app safely resets and re-seeds/re-syncs rather than crashing. Synced event data is also purged automatically once an event's `ends_at` plus a 24h grace period has passed.

Because `op-sqlite` is a native module, **this app cannot run in Expo Go** - it requires a custom dev client or a full prebuild:

```bash
npm install
npx expo prebuild        # generates ios/ and android/ native projects
npx expo run:android     # or: npx expo run:ios
# or, for a shareable dev client build:
eas build --profile development --platform android
```

## ⚙️ Configuration

Set `EXPO_PUBLIC_API_URL` (or `expo.extra.apiBaseUrl` in `app.json`) to your backend's `/api` URL. To enable Android push notifications, drop a free Firebase `google-services.json` into the project root before building - `app.config.js` picks it up automatically if present and is a no-op if it's absent.

## 📦 Scripts

- `npm start` — start the Expo dev server (Expo Go works for everything except local DB encryption; use a dev client for the full feature set)
- `npm run android` / `npm run ios` — run on device/emulator
- `npm run prebuild` — generate native projects (required once before `expo run:*` or local EAS builds)
- `npm run build:android` / `npm run build:ios` — EAS cloud builds
- `npm run lint` / `npm test` — lint and unit tests

## Future work

- iOS remote push (APNs) is fully implemented on the backend and gated behind `APNS_ENABLED=false` by default - it requires an Apple Developer Program membership. Flip the flag and configure `APNS_*` env vars on the backend to turn it on; no app-side changes are needed.
