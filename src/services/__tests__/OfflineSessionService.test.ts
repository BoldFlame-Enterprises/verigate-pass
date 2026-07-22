/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

import { OfflineSessionService } from '../OfflineSessionService';

const expected = {
  userId: 4,
  email: 'user@example.com',
  eventId: 9,
  deviceId: 'device-1',
  tokenBinding: 'token-family-1',
  credentialVersion: 'credential-v1',
};

describe('OfflineSessionService', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.restoreAllMocks();
  });

  it('returns a fully bound production session only within its 24-hour limit', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await OfflineSessionService.create(4, 'User@Example.com', 9, 'production', expected);

    expect(await OfflineSessionService.getValid(expected)).toMatchObject({
      schemaVersion: 3,
      userId: 4,
      eventId: 9,
      mode: 'production',
      deviceId: 'device-1',
      tokenBinding: 'token-family-1',
      credentialVersion: 'credential-v1',
      expiresAt: 1_000 + 24 * 60 * 60 * 1000,
    });

    jest.spyOn(Date, 'now').mockReturnValue(1_000 + 24 * 60 * 60 * 1000 + 1);
    expect(await OfflineSessionService.getValid(expected)).toBeNull();
  });

  it.each([
    ['identity', { ...expected, userId: 5 }],
    ['event', { ...expected, eventId: 10 }],
    ['device', { ...expected, deviceId: 'device-2' }],
    ['token family', { ...expected, tokenBinding: 'token-family-2' }],
    ['credential version', { ...expected, credentialVersion: 'credential-v2' }],
  ])('rejects and clears a session with a mismatched %s binding', async (_label, mismatch) => {
    await OfflineSessionService.create(4, expected.email, 9, 'production', expected);
    expect(await OfflineSessionService.getValid(mismatch)).toBeNull();
    expect(await OfflineSessionService.getMetadata()).toBeNull();
  });

  it('rejects a legacy session that has no device or version bindings', async () => {
    mockStore.set('verigate_pass_offline_session_v2', JSON.stringify({
      userId: 4,
      email: expected.email,
      eventId: 9,
      mode: 'production',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));

    expect(await OfflineSessionService.getMetadata(expected.email)).toBeNull();
  });

  it('keeps demo sessions device-bound without production token bindings', async () => {
    await OfflineSessionService.create(4, expected.email, 0, 'demo', {
      deviceId: expected.deviceId,
      tokenBinding: null,
      credentialVersion: null,
    });
    expect(await OfflineSessionService.getValid({
      ...expected,
      eventId: 0,
      tokenBinding: null,
      credentialVersion: null,
    })).toMatchObject({ mode: 'demo', deviceId: expected.deviceId });
  });

  it('refreshes a credential binding without extending the offline lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    await OfflineSessionService.create(4, expected.email, 9, 'production', expected);
    await OfflineSessionService.refreshProductionBinding({
      ...expected,
      eventId: 10,
      credentialVersion: 'credential-v2',
    });

    expect(await OfflineSessionService.getValid({
      ...expected,
      eventId: 10,
      credentialVersion: 'credential-v2',
    })).toMatchObject({
      eventId: 10,
      credentialVersion: 'credential-v2',
      issuedAt: 2_000,
      expiresAt: 2_000 + 24 * 60 * 60 * 1000,
    });
  });
});
