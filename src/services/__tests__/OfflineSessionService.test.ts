/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

import { OfflineSessionService } from '../OfflineSessionService';

describe('OfflineSessionService', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.restoreAllMocks();
  });

  it('returns a backend-established session only within its 24-hour bound', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await OfflineSessionService.create(4, 'User@Example.com', 9, 'production');

    expect(await OfflineSessionService.getValid('user@example.com')).toMatchObject({
      userId: 4,
      eventId: 9,
      mode: 'production',
      expiresAt: 1_000 + 24 * 60 * 60 * 1000,
    });

    jest.spyOn(Date, 'now').mockReturnValue(1_000 + 24 * 60 * 60 * 1000 + 1);
    expect(await OfflineSessionService.getValid()).toBeNull();
  });

  it('rejects a session requested for another identity', async () => {
    await OfflineSessionService.create(4, 'one@example.com', 9, 'production');
    expect(await OfflineSessionService.getValid('two@example.com')).toBeNull();
  });
});
