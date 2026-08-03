type RuntimeConfig = typeof import('./config');

const ORIGINAL_ENV = { ...process.env };

function loadConfig(
  extra: Record<string, unknown>,
  environment: Record<string, string | undefined> = {}
): RuntimeConfig {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { extra } },
  }));
  return jest.requireActual<RuntimeConfig>('./config');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
  jest.clearAllMocks();
});

describe('Pass runtime configuration', () => {
  it('allows the committed loopback origin only for unprofiled local work', () => {
    const config = loadConfig({
      apiBaseUrl: 'http://localhost:3000/api',
      demoMode: false,
      notificationsEnabled: false,
      buildProfile: null,
      buildPlatform: null,
    }, {
      EXPO_PUBLIC_API_URL: undefined,
      EXPO_PUBLIC_DEMO_MODE: undefined,
      EXPO_PUBLIC_NOTIFICATIONS_ENABLED: undefined,
    });

    expect(config.API_BASE_URL).toBe('http://localhost:3000/api');
    expect(config.BUILD_PROFILE).toBeNull();
    expect(config.NOTIFICATIONS_ENABLED).toBe(false);
  });

  it('accepts a safe profiled runtime configuration', () => {
    const config = loadConfig({
      apiBaseUrl: 'https://verigate-api.example.com/api',
      demoMode: false,
      notificationsEnabled: true,
      buildProfile: 'production',
      buildPlatform: 'ios',
    }, {
      EXPO_PUBLIC_API_URL: undefined,
      EXPO_PUBLIC_DEMO_MODE: undefined,
      EXPO_PUBLIC_NOTIFICATIONS_ENABLED: undefined,
    });

    expect(config.API_BASE_URL).toBe('https://verigate-api.example.com/api');
    expect(config.BUILD_PROFILE).toBe('production');
    expect(config.BUILD_PLATFORM).toBe('ios');
    expect(config.DEMO_MODE).toBe(false);
    expect(config.NOTIFICATIONS_ENABLED).toBe(true);
  });

  it('rejects unsafe runtime overrides in a profiled build', () => {
    const extra = {
      apiBaseUrl: 'https://verigate-api.example.com/api',
      demoMode: false,
      notificationsEnabled: true,
      buildProfile: 'production',
      buildPlatform: 'android',
    };
    const config = loadConfig(extra, {
      EXPO_PUBLIC_API_URL: undefined,
      EXPO_PUBLIC_DEMO_MODE: undefined,
      EXPO_PUBLIC_NOTIFICATIONS_ENABLED: undefined,
    });

    expect(() => config.resolveRuntimeConfig(extra, {
      apiBaseUrl: 'http://localhost:3000/api',
      demoMode: 'false',
      notificationsEnabled: 'true',
    })).toThrow(/API URL/i);
  });
});
