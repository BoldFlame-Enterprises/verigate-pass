/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'installation-uuid'),
}));

import { DeviceIdentityService } from '../DeviceIdentityService';

describe('Pass installation identity', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('creates one opaque installation identity and reuses it across launches', async () => {
    expect(await DeviceIdentityService.getOrCreate()).toBe('pass-installation-uuid');
    expect(await DeviceIdentityService.getOrCreate()).toBe('pass-installation-uuid');
    expect(mockStore.get('verigate_pass_installation_id')).toBe('pass-installation-uuid');
  });
});
