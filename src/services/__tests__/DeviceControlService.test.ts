/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('../ApiClient', () => ({
  ApiClient: {
    isAuthenticated: jest.fn(() => true),
    getDeviceState: jest.fn(),
    clearTokens: jest.fn(async () => undefined),
  },
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    code: string;
    constructor(mockStatus: number, mockCode: string, mockMessage: string) {
      super(mockMessage);
      this.status = mockStatus;
      this.code = mockCode;
    }
  },
  deviceControlReason: (error: { code?: string }) => {
    if (error.code === 'DEVICE_BLACKLISTED') return 'blacklisted';
    if (error.code?.startsWith('DEVICE_')) return 'deregistered';
    return null;
  },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { clear: jest.fn(async () => undefined) },
}));
jest.mock('../QrCredentialService', () => ({
  QrCredentialService: { revokeLocalAuthority: jest.fn(async () => undefined) },
}));
jest.mock('../SyncScheduler', () => ({
  SyncScheduler: { stop: jest.fn() },
}));

import { ApiClient, ApiRequestError } from '../ApiClient';
import { DeviceControlService } from '../DeviceControlService';
import { OfflineSessionService } from '../OfflineSessionService';
import { QrCredentialService } from '../QrCredentialService';
import { SyncScheduler } from '../SyncScheduler';

describe('Pass connected device enforcement', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  it.each([
    ['DEVICE_DEREGISTERED', 'deregistered'],
    ['DEVICE_BLACKLISTED', 'blacklisted'],
    ['DEVICE_SESSION_STALE', 'deregistered'],
  ])('revokes local authority for %s and persists a %s notice', async (code, reason) => {
    jest.mocked(ApiClient.getDeviceState).mockRejectedValue(
      new ApiRequestError(401, code, 'Registration revoked')
    );

    const result = await DeviceControlService.checkConnectedState();

    expect(result).toEqual({ status: 'revoked', reason });
    expect(SyncScheduler.stop).toHaveBeenCalled();
    expect(QrCredentialService.revokeLocalAuthority).toHaveBeenCalled();
    expect(OfflineSessionService.clear).toHaveBeenCalled();
    expect(ApiClient.clearTokens).toHaveBeenCalled();
    expect(await DeviceControlService.consumeNotice()).toEqual(expect.objectContaining({
      reason,
      message: expect.stringMatching(/log in again/i),
    }));
  });

  it('treats an unavailable network as offline rather than claiming revocation', async () => {
    jest.mocked(ApiClient.getDeviceState).mockRejectedValue(new TypeError('Network request failed'));

    await expect(DeviceControlService.checkConnectedState()).resolves.toEqual({
      status: 'offline',
    });
    expect(ApiClient.clearTokens).not.toHaveBeenCalled();
    expect(QrCredentialService.revokeLocalAuthority).not.toHaveBeenCalled();
  });

  it('stores the notice independently so credential cleanup cannot erase it', async () => {
    await DeviceControlService.revoke('blacklisted');
    await ApiClient.clearTokens();

    expect(await DeviceControlService.consumeNotice()).toMatchObject({
      reason: 'blacklisted',
    });
  });
});
