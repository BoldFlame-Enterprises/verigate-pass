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
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../ApiClient', () => ({
  ApiClient: {
    isAuthenticated: jest.fn(() => true),
    hasDeviceSession: jest.fn(() => false),
    getTokenBinding: jest.fn(() => 'token-family-1'),
    registerDeviceSession: jest.fn(async () => ({
      id: 9,
      event_id: 8,
      app: 'pass',
      installation_id: 'pass-installation',
      state: 'active',
      session_generation: 1,
      version: 1,
    })),
    request: jest.fn(),
  },
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
  QrCredentialService: {
    getPublicKeyPointBase64Url: jest.fn(async () => 'device-public-key'),
    allowRegisteredAuthority: jest.fn(async () => undefined),
    isV3Credential: jest.fn((credential: { p?: unknown }) => Boolean(credential?.p)),
    validateV3Credential: jest.fn(async (credential: unknown) => credential),
    credentialExpiresAtMs: jest.fn((credential: { p: { exp: number } }) => credential.p.exp * 1_000),
    credentialVersionIdentifier: jest.fn(() => 'qr-active:1'),
  },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { refreshProductionBinding: jest.fn(async () => undefined) },
}));
jest.mock('../DeviceIdentityService', () => ({
  DeviceIdentityService: { getOrCreate: jest.fn(async () => 'pass-installation') },
}));

import { ApiClient } from '../ApiClient';
import { DatabaseService } from '../DatabaseService';
import { SyncService } from '../SyncService';
import { OfflineSessionService } from '../OfflineSessionService';

describe('SyncService', () => {
  it('downloads only the authenticated attendee credential projection', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const user = { id: 5, event_id: 8, email: 'self@example.com', name: 'Self', phone: '1', is_active: true, assignments: [] };
    const context = {
      installation_id: 'pass-installation',
      registration_generation: 1,
      active_authority_key: {
        kid: 'qr-active',
        public_key: 'authority-public-key',
      },
    };
    const credential = {
      p: {
        v: 3,
        kid: 'qr-active',
        cid: 'credential-id',
        cg: 1,
        uid: 5,
        eid: 8,
        did: 'pass-installation',
        rg: 1,
        dpk: 'device-public-key',
        iat: nowSeconds,
        exp: nowSeconds + 86_400,
      },
      s: 'authority-signature',
    };
    jest.mocked(ApiClient.request).mockImplementation(async (path: string) => {
      if (path === '/events') return [{ id: 8, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/my-credential') {
        return {
          contract_version: 'event-user-v3',
          user,
          qr_credential_context: context,
        } as never;
      }
      if (path === '/qr/generate') {
        return {
          contract_version: 'qr-credential-v3',
          credential,
          active_authority_key_id: 'qr-active',
          registration_generation: 1,
          expires_at: nowSeconds + 86_400,
        } as never;
      }
      return {} as never;
    });

    const result = await SyncService.syncNow();

    expect(result.success).toBe(true);
    expect(ApiClient.registerDeviceSession).toHaveBeenCalledWith(
      8,
      'pass-installation',
      'android'
    );
    expect(ApiClient.request).toHaveBeenCalledWith('/sync/my-credential', { params: { event_id: 8 } });
    expect(ApiClient.request).not.toHaveBeenCalledWith('/sync/users-database', expect.anything());
    expect(DatabaseService.upsertSyncedUsers).toHaveBeenCalledWith([user]);
    expect(ApiClient.request).toHaveBeenCalledWith('/qr/generate', {
      params: {
        event_id: 8,
        device_id: 'pass-installation',
        device_public_key: 'device-public-key',
        protocol_version: 3,
      },
    });
    expect(DatabaseService.storeQrCredential).toHaveBeenCalledWith(credential, context);
    expect(OfflineSessionService.refreshProductionBinding).toHaveBeenCalledWith({
      userId: 5,
      email: 'self@example.com',
      eventId: 8,
      deviceId: 'pass-installation',
      tokenBinding: 'token-family-1',
      credentialVersion: 'qr-active:1',
    });
  });
});
