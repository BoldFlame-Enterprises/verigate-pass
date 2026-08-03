const path = require('path');
const configureApp = require('./app.config');
const appJson = require('./app.json');
const easJson = require('./eas.json');

function baseConfig() {
  return JSON.parse(JSON.stringify(appJson.expo));
}

function environment(overrides = {}) {
  return {
    VERIGATE_BUILD_PROFILE: 'production',
    VERIGATE_BUILD_PLATFORM: 'ios',
    EXPO_PUBLIC_API_URL: 'https://verigate-api.example.com/api',
    EXPO_PUBLIC_DEMO_MODE: 'false',
    EXPO_PUBLIC_NOTIFICATIONS_ENABLED: 'true',
    ...overrides,
  };
}

function fileSystem(files = {}) {
  return {
    existsSync: jest.fn((file) => Object.hasOwn(files, file)),
    readFileSync: jest.fn((file) => files[file]),
  };
}

describe('Pass Expo release configuration', () => {
  it('allows an unprofiled local configuration without pretending push is configured', () => {
    const resolved = configureApp.resolveConfig({
      config: baseConfig(),
      environment: {},
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    });

    expect(resolved.extra).toMatchObject({
      apiBaseUrl: 'http://localhost:3000/api',
      demoMode: false,
      notificationsEnabled: false,
    });
    expect(resolved.extra.buildProfile).toBeUndefined();
    expect(resolved.extra.buildPlatform).toBeUndefined();
    expect(resolved.android.googleServicesFile).toBeUndefined();
  });

  it.each([
    '',
    'http://verigate-api.example.com/api',
    'https://localhost/api',
    'https://127.0.0.1/api',
    'https://verigate-api.example.com',
    'https://user:password@verigate-api.example.com/api',
    'https://verigate-api.example.com/api?debug=true',
  ])('rejects an unsafe profiled API URL: %s', (apiBaseUrl) => {
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ EXPO_PUBLIC_API_URL: apiBaseUrl }),
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    })).toThrow(/API URL/i);
  });

  it('rejects demo mode in a profiled build', () => {
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ EXPO_PUBLIC_DEMO_MODE: 'true' }),
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    })).toThrow(/demo mode/i);
  });

  it('requires an explicit platform and notification capability in a profiled build', () => {
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ VERIGATE_BUILD_PLATFORM: undefined }),
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    })).toThrow(/platform/i);

    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ EXPO_PUBLIC_NOTIFICATIONS_ENABLED: undefined }),
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    })).toThrow(/notification capability/i);
  });

  it('requires matching Google services configuration for notification-capable Android builds', () => {
    const androidEnvironment = environment({ VERIGATE_BUILD_PLATFORM: 'android' });
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: androidEnvironment,
      projectRoot: __dirname,
      fileSystem: fileSystem(),
    })).toThrow(/Google services/i);

    const googleServicesPath = path.resolve(__dirname, 'provider/google-services.json');
    const mismatchedFiles = fileSystem({
      [googleServicesPath]: JSON.stringify({
        client: [{ client_info: { android_client_info: { package_name: 'com.example.wrong' } } }],
      }),
    });
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: {
        ...androidEnvironment,
        GOOGLE_SERVICES_JSON: 'provider/google-services.json',
      },
      projectRoot: __dirname,
      fileSystem: mismatchedFiles,
    })).toThrow(/com\.verigate\.pass/);
  });

  it('resolves a matching Android provider file without exposing its contents', () => {
    const googleServicesPath = path.resolve(__dirname, 'provider/google-services.json');
    const files = fileSystem({
      [googleServicesPath]: JSON.stringify({
        project_info: { project_number: '1234567890' },
        client: [{ client_info: { android_client_info: { package_name: 'com.verigate.pass' } } }],
      }),
    });
    const resolved = configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({
        VERIGATE_BUILD_PLATFORM: 'android',
        GOOGLE_SERVICES_JSON: 'provider/google-services.json',
      }),
      projectRoot: __dirname,
      fileSystem: files,
    });

    expect(resolved.android.googleServicesFile).toBe(googleServicesPath);
    expect(resolved.extra).toMatchObject({
      apiBaseUrl: 'https://verigate-api.example.com/api',
      demoMode: false,
      notificationsEnabled: true,
      buildProfile: 'production',
      buildPlatform: 'android',
    });
  });

  it.each(['development', 'preview', 'production'])(
    'resolves both platforms for the %s EAS profile',
    (profileName) => {
      const profile = easJson.build[profileName];
      expect(profile.environment).toBe(profileName);
      expect(profile.env).toMatchObject({
        VERIGATE_BUILD_PROFILE: profileName,
        EXPO_PUBLIC_API_URL: 'https://verigate-api-flle.onrender.com/api',
        EXPO_PUBLIC_DEMO_MODE: 'false',
        EXPO_PUBLIC_NOTIFICATIONS_ENABLED: 'true',
      });

      const ios = configureApp.resolveConfig({
        config: baseConfig(),
        environment: { ...profile.env, ...profile.ios.env },
        projectRoot: __dirname,
        fileSystem: fileSystem(),
      });
      expect(ios.extra).toMatchObject({
        buildProfile: profileName,
        buildPlatform: 'ios',
        apiBaseUrl: 'https://verigate-api-flle.onrender.com/api',
        demoMode: false,
        notificationsEnabled: true,
      });

      const googleServicesPath = path.resolve(__dirname, 'provider/google-services.json');
      const android = configureApp.resolveConfig({
        config: baseConfig(),
        environment: {
          ...profile.env,
          ...profile.android.env,
          GOOGLE_SERVICES_JSON: 'provider/google-services.json',
        },
        projectRoot: __dirname,
        fileSystem: fileSystem({
          [googleServicesPath]: JSON.stringify({
            client: [{ client_info: { android_client_info: { package_name: 'com.verigate.pass' } } }],
          }),
        }),
      });
      expect(android.extra).toMatchObject({
        buildProfile: profileName,
        buildPlatform: 'android',
        apiBaseUrl: 'https://verigate-api-flle.onrender.com/api',
        demoMode: false,
        notificationsEnabled: true,
      });
      expect(android.android.googleServicesFile).toBe(googleServicesPath);
    }
  );

  it('does not request camera authority in Pass', () => {
    expect(appJson.expo.android.permissions).not.toContain('android.permission.CAMERA');
    expect(appJson.expo.ios.infoPlist.NSCameraUsageDescription).toBeUndefined();
  });
});
