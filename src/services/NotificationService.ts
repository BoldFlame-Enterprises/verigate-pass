import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ApiClient } from './ApiClient';
import { SyncService } from './SyncService';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const QR_EXPIRY_NOTIFICATION_ID = 'qr-expiry-reminder';

class NotificationServiceClass {
  private responseListener: Notifications.Subscription | null = null;

  /** Requests permission and, on Android, registers the raw FCM device token
   * with the backend so admin permission changes / announcements can be
   * pushed. iOS registration is a no-op unless the backend has APNs enabled -
   * the app always tries local notifications regardless of remote push. */
  async init(): Promise<void> {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('Notification permission not granted - local reminders disabled');
      return;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'VeriGate Pass',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    this.responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { type?: string };
      if (data?.type === 'access_change') {
        SyncService.syncNow(null).catch(() => undefined);
      }
    });

    await this.registerDeviceToken();
  }

  teardown(): void {
    this.responseListener?.remove();
  }

  private async registerDeviceToken(): Promise<void> {
    if (!ApiClient.isAuthenticated()) return;

    try {
      const eventId = await SyncService.getCurrentEventId();
      if (!eventId) return;

      const platform = Platform.OS === 'ios' ? 'ios' : 'android';
      const tokenResponse = await Notifications.getDevicePushTokenAsync();

      await ApiClient.request('/notifications/register-device', {
        method: 'POST',
        body: { event_id: eventId, token: tokenResponse.data, platform },
      });
    } catch (error) {
      // Device push registration is best-effort (e.g. no Google Play
      // services on an emulator, or APNs not configured) - never blocks login.
      console.warn('Device push registration skipped:', error instanceof Error ? error.message : error);
    }
  }

  /** Schedules a local reminder a few minutes before the current QR expires. */
  async scheduleQrExpiryReminder(expiresAt: number, warnMsBefore: number): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(QR_EXPIRY_NOTIFICATION_ID).catch(() => undefined);

    const fireAt = expiresAt - warnMsBefore;
    if (fireAt <= Date.now()) return;

    await Notifications.scheduleNotificationAsync({
      identifier: QR_EXPIRY_NOTIFICATION_ID,
      content: {
        title: 'Your QR code is expiring soon',
        body: 'Reopen VeriGate Pass to refresh your access QR code.',
        data: { type: 'qr_expiry' },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireAt) },
    });
  }

  async cancelQrExpiryReminder(): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(QR_EXPIRY_NOTIFICATION_ID).catch(() => undefined);
  }
}

export const NotificationService = new NotificationServiceClass();
