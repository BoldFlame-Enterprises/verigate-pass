import Constants from 'expo-constants';

// Overridable via app.json -> expo.extra.apiBaseUrl, or EXPO_PUBLIC_API_URL at build time.
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  'http://localhost:3000/api';

export const DEMO_MODE: boolean =
  process.env.EXPO_PUBLIC_DEMO_MODE === 'true' ||
  Constants.expoConfig?.extra?.demoMode === true;

// APNS_ENABLED mirrors the backend flag; the app only attempts to register
// for remote push at all once a backend event tells it push is available,
// but this default keeps iOS registration inert unless explicitly turned on.
export const EVENT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const AUTO_LOGOUT_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
export const QR_EXPIRY_WARNING_MS = 5 * 60 * 1000; // warn 5 minutes before QR expiry
