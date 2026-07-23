/* eslint-disable import/first */
const mockStore = new Map<string, string>();
const mockFirstListener = { remove: jest.fn() };
const mockSecondListener = { remove: jest.fn() };

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationHandler: jest.fn(),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  addNotificationResponseReceivedListener: jest.fn()
    .mockReturnValueOnce(mockFirstListener)
    .mockReturnValueOnce(mockSecondListener),
  getDevicePushTokenAsync: jest.fn(async () => ({ data: 'raw-provider-token' })),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  unregisterForNotificationsAsync: jest.fn(async () => undefined),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../ApiClient', () => ({
  ApiClient: { isAuthenticated: jest.fn(() => true), request: jest.fn(async () => ({})) },
}));
jest.mock('../SyncService', () => ({
  SyncService: { getCurrentEventId: jest.fn(async () => 7), syncNow: jest.fn(async () => ({ success: true })) },
}));

import * as Notifications from 'expo-notifications';
import { ApiClient } from '../ApiClient';
import { NotificationService } from '../NotificationService';

describe('NotificationService lifecycle', () => {
  beforeEach(() => {
    NotificationService.teardown();
    mockStore.clear();
    jest.clearAllMocks();
    jest.mocked(Notifications.addNotificationResponseReceivedListener).mockReset()
      .mockReturnValueOnce(mockFirstListener as never)
      .mockReturnValueOnce(mockSecondListener as never);
    jest.mocked(ApiClient.isAuthenticated).mockReturnValue(true);
    jest.mocked(ApiClient.request).mockResolvedValue({} as never);
  });

  it('replaces the prior listener and stores the successfully registered raw token', async () => {
    await NotificationService.init();
    await NotificationService.init();

    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(2);
    expect(mockFirstListener.remove).toHaveBeenCalledTimes(1);
    expect(mockSecondListener.remove).not.toHaveBeenCalled();
    expect(mockStore.get('verigate_pass_registered_push_token')).toBe('raw-provider-token');
  });

  it('continues native, listener, reminder, and token cleanup when backend unregister fails', async () => {
    await NotificationService.init();
    jest.mocked(ApiClient.request).mockRejectedValueOnce(new Error('offline'));

    const result = await NotificationService.cleanupForLogout();

    expect(ApiClient.request).toHaveBeenLastCalledWith('/notifications/unregister-device', {
      method: 'POST',
      body: { token: 'raw-provider-token' },
    });
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('qr-expiry-reminder');
    expect(Notifications.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(mockFirstListener.remove).toHaveBeenCalledTimes(1);
    expect(mockStore.has('verigate_pass_registered_push_token')).toBe(false);
    expect(result).toEqual({ backendUnregistered: false, nativeUnregistered: true });
  });
});
