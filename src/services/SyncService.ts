import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { ApiClient } from './ApiClient';
import { DatabaseService, User } from './DatabaseService';

const CURRENT_EVENT_ID_KEY = 'verigate_pass_event_id';
const CURRENT_EVENT_NAME_KEY = 'verigate_pass_event_name';
const LAST_SYNC_AT_KEY = 'verigate_pass_last_sync_at';

interface RemoteEvent {
  id: number;
  name: string;
  slug: string;
  ends_at: string | null;
}

interface SyncResult {
  success: boolean;
  eventId?: number;
  eventName?: string;
  userCount?: number;
  error?: string;
}

class SyncServiceClass {
  private deviceId: string | null = null;

  private async getDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    this.deviceId =
      Platform.OS === 'android'
        ? (Application.getAndroidId() ?? `pass-${Date.now()}`)
        : ((await Application.getIosIdForVendorAsync()) ?? `pass-${Date.now()}`);
    return this.deviceId;
  }

  async getCurrentEventId(): Promise<number | null> {
    const stored = await SecureStore.getItemAsync(CURRENT_EVENT_ID_KEY);
    return stored ? Number(stored) : null;
  }

  async getCurrentEventName(): Promise<string | null> {
    return SecureStore.getItemAsync(CURRENT_EVENT_NAME_KEY);
  }

  async getLastSyncAt(): Promise<number | null> {
    const stored = await SecureStore.getItemAsync(LAST_SYNC_AT_KEY);
    return stored ? Number(stored) : null;
  }

  /**
   * Pulls the user's event membership + this event's user record (with real,
   * server-assigned access levels/areas) down into the local encrypted store,
   * and reports a sync heartbeat for the dashboard's real-time monitor.
   * Fails open: on any network error, the app keeps working from whatever
   * was last synced (or the local demo seed on first run).
   */
  /**
   * @param email The current user's email, used to sync just their own
   *   record. Pass `null` explicitly to sync every user returned for the
   *   event instead (used when reacting to a generic "access changed" push,
   *   where the affected user isn't known client-side).
   */
  async syncNow(email: string | null): Promise<SyncResult> {
    try {
      if (!ApiClient.isAuthenticated()) {
        return { success: false, error: 'Not authenticated with backend' };
      }

      const events = await ApiClient.request<RemoteEvent[]>('/events');
      if (events.length === 0) {
        return { success: false, error: 'No events assigned to this account yet' };
      }

      let eventId = await this.getCurrentEventId();
      let event = events.find((e) => e.id === eventId) ?? events[0];
      eventId = event.id;

      const usersData = await ApiClient.request<{ users: User[] }>('/sync/users-database', {
        params: { event_id: eventId },
      });

      const matchingUser = email ? usersData.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) : null;
      await DatabaseService.upsertSyncedUsers(matchingUser ? [matchingUser] : usersData.users);

      if (event.ends_at) {
        await DatabaseService.purgeIfEventExpired(new Date(event.ends_at).getTime());
      }

      await SecureStore.setItemAsync(CURRENT_EVENT_ID_KEY, String(eventId));
      await SecureStore.setItemAsync(CURRENT_EVENT_NAME_KEY, event.name);
      await SecureStore.setItemAsync(LAST_SYNC_AT_KEY, String(Date.now()));

      const deviceId = await this.getDeviceId();
      await ApiClient.request('/notifications/sync-heartbeat', {
        method: 'POST',
        body: { device_id: deviceId, app: 'pass', event_id: eventId, platform: Platform.OS },
      }).catch(() => undefined); // heartbeat is best-effort, never blocks sync

      return { success: true, eventId, eventName: event.name, userCount: usersData.users.length };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
    }
  }
}

export const SyncService = new SyncServiceClass();
