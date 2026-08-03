const fs = require('fs');
const path = require('path');

const ANDROID_PACKAGE = 'com.verigate.pass';
const PROFILED_PLATFORMS = new Set(['android', 'ios']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${label} must be either true or false`);
}

function safeProfiledApiUrl(value) {
  if (!nonEmpty(value)) {
    throw new Error('A profiled Pass build requires an API URL');
  }

  let parsed;
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

function resolveGoogleServices({ environment, projectRoot, fileSystem }) {
  const configuredPath = nonEmpty(environment.GOOGLE_SERVICES_JSON);
  if (!configuredPath) {
    throw new Error('Google services configuration is required for notification-capable Android builds');
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
  if (!fileSystem.existsSync(resolvedPath)) {
    throw new Error('Google services configuration is required but the configured file is unavailable');
  }

  let providerConfig;
  try {
    providerConfig = JSON.parse(fileSystem.readFileSync(resolvedPath, 'utf8'));
  } catch {
    throw new Error('Google services configuration is not valid JSON');
  }
  const matchesPackage = Array.isArray(providerConfig.client) &&
    providerConfig.client.some((client) =>
      client?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE
    );
  if (!matchesPackage) {
    throw new Error(`Google services configuration must contain Android package ${ANDROID_PACKAGE}`);
  }
  return resolvedPath;
}

function resolveConfig({
  config,
  environment = process.env,
  projectRoot = __dirname,
  fileSystem = fs,
}) {
  const buildProfile = nonEmpty(environment.VERIGATE_BUILD_PROFILE) ||
    nonEmpty(environment.EAS_BUILD_PROFILE);
  const buildPlatform = nonEmpty(environment.VERIGATE_BUILD_PLATFORM) ||
    nonEmpty(environment.EAS_BUILD_PLATFORM);
  const profiled = buildProfile !== null;
  if (profiled && !PROFILED_PLATFORMS.has(buildPlatform)) {
    throw new Error('A profiled Pass build requires an explicit android or ios platform');
  }

  const configuredApiUrl = nonEmpty(environment.EXPO_PUBLIC_API_URL) ||
    nonEmpty(config.extra?.apiBaseUrl) ||
    'http://localhost:3000/api';
  const apiBaseUrl = profiled ? safeProfiledApiUrl(configuredApiUrl) : configuredApiUrl;
  const demoMode = parseBoolean(
    environment.EXPO_PUBLIC_DEMO_MODE,
    config.extra?.demoMode === true,
    'Pass demo mode'
  );
  if (profiled && demoMode) {
    throw new Error('Pass demo mode must be disabled for profiled builds');
  }

  if (profiled && environment.EXPO_PUBLIC_NOTIFICATIONS_ENABLED === undefined) {
    throw new Error('A profiled Pass build requires an explicit notification capability');
  }
  const notificationsEnabled = parseBoolean(
    environment.EXPO_PUBLIC_NOTIFICATIONS_ENABLED,
    config.extra?.notificationsEnabled === true,
    'Pass notification capability'
  );
  if (notificationsEnabled && !PROFILED_PLATFORMS.has(buildPlatform)) {
    throw new Error('An explicit platform is required when Pass notifications are enabled');
  }

  const android = { ...config.android };
  delete android.googleServicesFile;
  if (notificationsEnabled && buildPlatform === 'android') {
    android.googleServicesFile = resolveGoogleServices({ environment, projectRoot, fileSystem });
  }

  const resolvedExtra = {
    ...config.extra,
    apiBaseUrl,
    demoMode,
    notificationsEnabled,
  };
  delete resolvedExtra.buildProfile;
  delete resolvedExtra.buildPlatform;
  if (profiled) {
    resolvedExtra.buildProfile = buildProfile;
    resolvedExtra.buildPlatform = buildPlatform;
  }

  return {
    ...config,
    android,
    extra: resolvedExtra,
  };
}

function configureApp({ config }) {
  return resolveConfig({ config });
}

configureApp.resolveConfig = resolveConfig;
module.exports = configureApp;
