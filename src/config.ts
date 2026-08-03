import Constants from 'expo-constants';

type BuildPlatform = 'android' | 'ios';

const extra = Constants.expoConfig?.extra ?? {};

interface PublicRuntimeEnvironment {
  apiBaseUrl?: string;
  demoMode?: string;
  notificationsEnabled?: string;
}

interface ResolvedRuntimeConfig {
  apiBaseUrl: string;
  buildProfile: string | null;
  buildPlatform: BuildPlatform | null;
  demoMode: boolean;
  notificationsEnabled: boolean;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be either true or false`);
}

function safeProfiledApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The profiled Pass API URL is malformed');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (
    parsed.protocol !== 'https:' ||
    loopback ||
    pathname !== '/api' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('The profiled Pass API URL must be a credential-free HTTPS origin ending in /api');
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, '');
}

export function resolveRuntimeConfig(
  configuredExtra: Record<string, unknown>,
  environment: PublicRuntimeEnvironment
): ResolvedRuntimeConfig {
  const buildProfile = optionalString(configuredExtra.buildProfile);
  const platform = optionalString(configuredExtra.buildPlatform);
  const buildPlatform: BuildPlatform | null =
    platform === 'android' || platform === 'ios' ? platform : null;
  const configuredApiUrl = optionalString(environment.apiBaseUrl) ||
    optionalString(configuredExtra.apiBaseUrl) ||
    'http://localhost:3000/api';
  const apiBaseUrl = buildProfile
    ? safeProfiledApiUrl(configuredApiUrl)
    : configuredApiUrl;
  const demoMode = booleanValue(
    environment.demoMode,
    configuredExtra.demoMode === true,
    'Pass demo mode'
  );
  if (buildProfile && demoMode) {
    throw new Error('Pass demo mode must be disabled for profiled builds');
  }
  const notificationsEnabled = booleanValue(
    environment.notificationsEnabled,
    configuredExtra.notificationsEnabled === true,
    'Pass notification capability'
  );
  if (buildProfile && !buildPlatform) {
    throw new Error('A profiled Pass runtime requires an explicit android or ios platform');
  }
  return { apiBaseUrl, buildProfile, buildPlatform, demoMode, notificationsEnabled };
}

const runtimeConfig = resolveRuntimeConfig(extra, {
  apiBaseUrl: process.env.EXPO_PUBLIC_API_URL,
  demoMode: process.env.EXPO_PUBLIC_DEMO_MODE,
  notificationsEnabled: process.env.EXPO_PUBLIC_NOTIFICATIONS_ENABLED,
});

export const BUILD_PROFILE = runtimeConfig.buildProfile;
export const BUILD_PLATFORM = runtimeConfig.buildPlatform;
export const API_BASE_URL = runtimeConfig.apiBaseUrl;
export const DEMO_MODE = runtimeConfig.demoMode;
export const NOTIFICATIONS_ENABLED = runtimeConfig.notificationsEnabled;

export const EVENT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const AUTO_LOGOUT_INACTIVITY_MS = 5 * 60 * 1000;
export const QR_EXPIRY_WARNING_MS = 5 * 60 * 1000;
