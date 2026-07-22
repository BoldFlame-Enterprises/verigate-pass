/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-application', () => ({
  getAndroidId: jest.fn(() => 'android-device'),
  getIosIdForVendorAsync: jest.fn(async () => 'ios-device'),
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'fallback-device') }));
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Platform: { OS: 'android' },
}));
jest.mock('../ApiClient', () => ({
  ApiClient: { isAuthenticated: jest.fn(() => true), getTokenBinding: jest.fn(() => 'token-family-1'), request: jest.fn() },
}));
jest.mock('../DatabaseService', () => ({
  DatabaseService: {
    upsertSyncedUsers: jest.fn(async () => undefined),
    getQrCredential: jest.fn(async () => null),
    storeQrCredential: jest.fn(async () => undefined),
    purgeIfEventExpired: jest.fn(async () => false),
  },
}));
jest.mock('../QrCredentialService', () => ({
  QrCredentialService: { getPublicKeySpkiBase64: jest.fn(async () => 'device-public-key') },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { refreshProductionBinding: jest.fn(async () => undefined) },
}));

import { ApiClient } from '../ApiClient';
import { DatabaseService, User } from '../DatabaseService';
import { AuthorityCredential } from '../QrCredentialService';
import { ForegroundSyncScheduler } from '../SyncScheduler';
import { SyncService } from '../SyncService';

class FakeAppState {
  currentState: 'active' | 'background' = 'active';
  listener: ((state: 'active' | 'background') => void) | null = null;
  remove = jest.fn();

  addEventListener(_type: 'change', listener: (state: 'active' | 'background') => void) {
    this.listener = listener;
    return { remove: this.remove };
  }

  change(state: 'active' | 'background') {
    this.currentState = state;
    this.listener?.(state);
  }
}

const flushPromises = () => jest.advanceTimersByTimeAsync(0);

describe('ForegroundSyncScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately, repeats every 10 seconds, and removes timers and listeners on stop', async () => {
    const synchronize = jest.fn(async () => ({ success: true }));
    const appState = new FakeAppState();
    const scheduler = new ForegroundSyncScheduler(synchronize, appState, () => 0);

    scheduler.start();
    expect(synchronize).toHaveBeenCalledTimes(1);
    await flushPromises();

    jest.advanceTimersByTime(9_999);
    expect(synchronize).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    await flushPromises();

    scheduler.stop();
    jest.advanceTimersByTime(60_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(appState.remove).toHaveBeenCalledTimes(1);
  });

  it('pauses in the background and synchronizes immediately on foreground resume', async () => {
    const synchronize = jest.fn(async () => ({ success: true }));
    const appState = new FakeAppState();
    const scheduler = new ForegroundSyncScheduler(synchronize, appState, () => 0);

    scheduler.start();
    await flushPromises();
    appState.change('background');
    jest.advanceTimersByTime(60_000);
    expect(synchronize).toHaveBeenCalledTimes(1);

    appState.change('active');
    expect(synchronize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('joins a manual request to an in-flight automatic run without overlap', async () => {
    let resolveSync!: (result: { success: boolean }) => void;
    const synchronize = jest.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveSync = resolve;
    }));
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    const firstManual = scheduler.syncNow();
    const secondManual = scheduler.syncNow();

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(firstManual).toBe(secondManual);
    resolveSync({ success: true });
    await firstManual;
    expect(onSuccess).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('keeps automatic failures silent and retries with bounded exponential backoff', async () => {
    const synchronize = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: true });
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    await flushPromises();
    jest.advanceTimersByTime(10_000);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(19_999);
    expect(synchronize).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not notify or schedule after stopping an in-flight run', async () => {
    let resolveSync!: (result: { success: boolean }) => void;
    const synchronize = jest.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveSync = resolve;
    }));
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    scheduler.stop();
    resolveSync({ success: true });
    await flushPromises();
    jest.advanceTimersByTime(60_000);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });
});

describe('SyncService credential renewal', () => {
  const assignments = [{
    area_id: 3,
    area_name: 'Gate A',
    access_level_id: 2,
    access_level_name: 'Staff',
    access_priority: 10,
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_until: '2026-08-01T00:00:00.000Z',
  }];
  const user: User = {
    id: 5,
    event_id: 8,
    email: 'self@example.com',
    name: 'Self',
    phone: '1',
    access_level: 'Staff',
    allowed_areas: ['Gate A'],
    assignments,
    is_active: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ApiClient.request).mockImplementation(async (path: string) => {
      if (path === '/events') return [{ id: 8, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/my-credential') return { contract_version: 'event-user-v2', user } as never;
      if (path === '/qr/generate') return { credential: currentCredential(assignments) } as never;
      return {} as never;
    });
  });

  function currentCredential(value = assignments): AuthorityCredential {
    return {
      payload: {
        version: 'verigate-qr-v2',
        credential_id: 'credential-1',
        credential_version: 'version-1',
        user_id: user.id,
        email: user.email,
        name: user.name,
        event_id: 8,
        device_id: 'android-device',
        device_public_key: 'device-public-key',
        assignments: value,
        issued_at: Date.now() - 60_000,
        expires_at: Date.now() + 60 * 60_000,
      },
      authority_signature: 'signature',
      authority_public_key: 'authority-key',
    };
  }

  it('reuses a valid matching authority credential while refreshing access data', async () => {
    jest.mocked(DatabaseService.getQrCredential).mockResolvedValue(currentCredential());

    const result = await SyncService.syncNow();

    expect(result).toMatchObject({ success: true, credentialRenewed: false });
    expect(DatabaseService.upsertSyncedUsers).toHaveBeenCalledWith([user]);
    expect(ApiClient.request).not.toHaveBeenCalledWith('/qr/generate', expect.anything());
    expect(DatabaseService.storeQrCredential).not.toHaveBeenCalled();
  });

  it('renews the authority credential when the access projection changes', async () => {
    jest.mocked(DatabaseService.getQrCredential).mockResolvedValue(currentCredential([]));

    const result = await SyncService.syncNow();

    expect(result).toMatchObject({ success: true, credentialRenewed: true });
    expect(ApiClient.request).toHaveBeenCalledWith('/qr/generate', {
      params: {
        event_id: 8,
        device_id: 'android-device',
        device_public_key: 'device-public-key',
      },
    });
    expect(DatabaseService.storeQrCredential).toHaveBeenCalledTimes(1);
  });
});
