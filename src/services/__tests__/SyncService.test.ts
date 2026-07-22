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
import { DatabaseService } from '../DatabaseService';
import { SyncService } from '../SyncService';
import { OfflineSessionService } from '../OfflineSessionService';

describe('SyncService', () => {
  it('downloads only the authenticated attendee credential projection', async () => {
    const user = { id: 5, event_id: 8, email: 'self@example.com', name: 'Self', phone: '1', is_active: true, assignments: [] };
    const credential = {
      payload: {
        credential_version: 'credential-v1',
        user_id: 5,
        event_id: 8,
      },
    };
    jest.mocked(ApiClient.request).mockImplementation(async (path: string) => {
      if (path === '/events') return [{ id: 8, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/my-credential') return { contract_version: 'event-user-v2', user } as never;
      if (path === '/qr/generate') return { credential } as never;
      return {} as never;
    });

    const result = await SyncService.syncNow();

    expect(result.success).toBe(true);
    expect(ApiClient.request).toHaveBeenCalledWith('/sync/my-credential', { params: { event_id: 8 } });
    expect(ApiClient.request).not.toHaveBeenCalledWith('/sync/users-database', expect.anything());
    expect(DatabaseService.upsertSyncedUsers).toHaveBeenCalledWith([user]);
    expect(DatabaseService.storeQrCredential).toHaveBeenCalledWith(credential);
    expect(OfflineSessionService.refreshProductionBinding).toHaveBeenCalledWith({
      userId: 5,
      email: 'self@example.com',
      eventId: 8,
      deviceId: 'android-device',
      tokenBinding: 'token-family-1',
      credentialVersion: 'credential-v1',
    });
  });
});
