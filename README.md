# VeriGate Pass App

The mobile app event attendees use to display their signed, device-bound QR code for accreditation.

## 🚀 Features

- **Signed, offline QR display**: the backend issues a P-256 event/device credential; Pass signs a rotating 60-second presentation with a per-installation SecureStore key.
- **Bounded replay model**: screen-capture blocking reduces accidental sharing, but a copied presentation can be replayed during its short validity window; zero offline replay is not claimed.
- **Screen-capture protection**: `expo-screen-capture` blocks screenshots/screen recording app-wide.
- **Backgrounding protection + auto-logout**: a blur overlay covers the screen the instant the app backgrounds (`expo-blur`), and the session is force-logged-out after 5 minutes of inactivity or backgrounding.
- **Biometric login**: optional Face ID / fingerprint unlock (`expo-local-authentication`) for a remembered session, credentials held in `expo-secure-store`.
- **Foreground event sync**: production login authenticates against the backend and downloads the caller's complete assignment-rich event projection. While the authenticated screen is active, the scheduler polls at a nominal 10-second cadence and uses bounded backoff/jitter after failure. Background execution is not supported; manual sync remains available. Blank-password local data is available only when `EXPO_PUBLIC_DEMO_MODE=true`.
- **Access-level indicator + permitted areas**: badge and detail view showing the user's access level, permitted/restricted areas, and QR validity.
- **Notifications**: local QR-expiry reminders use `expo-notifications`. Authenticated provider registration stores the raw token locally; manual and inactivity logout attempt backend/native unregistration, cancel reminders, remove the response listener, and clear the stored token without blocking logout on network failure.

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

Set `EXPO_PUBLIC_API_URL` (or `expo.extra.apiBaseUrl` in `app.json`) to your backend's `/api` URL. Android provider configuration may use `google-services.json`; treat that Firebase client configuration as public configuration and restrict its Firebase services rather than treating it as a private signing key. Private local EAS/signing/provider files such as `credentials.json`, `*.jks`, `*.p8`, `*.p12`, and `*.mobileprovision` are ignored.

## 📦 Scripts

- `npm start` — start the Expo bundler; the app itself requires a custom dev client/full native build because SQLCipher is native and is not available in Expo Go.
- `npm run android` / `npm run ios` — run on device/emulator
- `npm run prebuild` — generate native projects (required once before `expo run:*` or local EAS builds)
- `npm run build:android` / `npm run build:ios` — EAS cloud builds
- `npm run type-check` / `npm run lint` / `npm run doctor` — static validation
- `npm test` — run the committed service/contract tests without watch mode

## Validation boundary

Repository release evidence covers signed Android cloud build/publication for an exact source revision. It does not prove installation, physical-device notification cleanup/delivery, background/process-kill behavior, or any iOS/APNs behavior. APNs remains gated off by default and requires separate provider/device validation.

Pass and backend revisions must be inventoried before a database rollout.
Repository validation does not establish that a particular mobile build is
installed. Follow the aggregate repository's
`docs/database-operations.md` compatibility, restore, and observation gates
before changing a shared backend schema.
