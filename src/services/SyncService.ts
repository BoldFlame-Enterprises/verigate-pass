import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { ApiClient } from './ApiClient';
import { DatabaseService, User } from './DatabaseService';
import { QrCredentialService, AuthorityCredential } from './QrCredentialService';
import { OfflineSessionService } from './OfflineSessionService';

const CURRENT_EVENT_ID_KEY = 'verigate_pass_event_id';
const CURRENT_EVENT_NAME_KEY = 'verigate_pass_event_name';
const LAST_SYNC_AT_KEY = 'verigate_pass_last_sync_at';
const FALLBACK_DEVICE_ID_KEY = 'verigate_pass_fallback_device_id';

interface RemoteEvent {
  id: number;
  name: string;
  slug: string;
  ends_at: string | null;
}

export interface SyncResult {
  success: boolean;
  eventId?: number;
  eventName?: string;
  userCount?: number;
  credentialRenewed?: boolean;
  error?: string;
}

const CREDENTIAL_RENEWAL_WINDOW_MS = 60_000;
const MINIMUM_CREDENTIAL_AGE_FOR_EARLY_RENEWAL_MS = 5 * 60_000;

function sameAssignments(left: AuthorityCredential['payload']['assignments'], right: User['assignments']): boolean {
  const normalize = (assignments: User['assignments'] = []) => [...assignments]
    .sort((a, b) => a.area_id - b.area_id || a.access_level_id - b.access_level_id)
    .map((assignment) => ({
      area_id: assignment.area_id,
      area_name: assignment.area_name,
      access_level_id: assignment.access_level_id,
      access_level_name: assignment.access_level_name,
      access_priority: assignment.access_priority,
      valid_from: assignment.valid_from,
      valid_until: assignment.valid_until,
    }));

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

class SyncServiceClass {
  private deviceId: string | null = null;
  private inFlight: Promise<SyncResult> | null = null;

  async getDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    const platformId = Platform.OS === 'android'
      ? Application.getAndroidId()
      : await Application.getIosIdForVendorAsync();
    if (platformId) {
      this.deviceId = platformId;
      return this.deviceId;
    }
    this.deviceId = await SecureStore.getItemAsync(FALLBACK_DEVICE_ID_KEY);
    if (!this.deviceId) {
      this.deviceId = `pass-${Crypto.randomUUID()}`;
      await SecureStore.setItemAsync(FALLBACK_DEVICE_ID_KEY, this.deviceId);
    }
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

  async syncNow(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.performSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performSync(): Promise<SyncResult> {
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

      const credentialData = await ApiClient.request<{ contract_version: string; user: User }>('/sync/my-credential', {
        params: { event_id: eventId },
      });
      await DatabaseService.upsertSyncedUsers([credentialData.user]);

      const deviceId = await this.getDeviceId();
      const currentCredential = await DatabaseService.getQrCredential?.(eventId, credentialData.user.id) ?? null;
      const now = Date.now();
      const credentialMatches = currentCredential
        && currentCredential.payload.event_id === eventId
        && currentCredential.payload.user_id === credentialData.user.id
        && currentCredential.payload.device_id === deviceId
        && currentCredential.payload.email === credentialData.user.email
        && currentCredential.payload.name === credentialData.user.name
        && sameAssignments(currentCredential.payload.assignments, credentialData.user.assignments);
      const shouldRenewSoon = currentCredential
        && currentCredential.payload.expires_at - now <= CREDENTIAL_RENEWAL_WINDOW_MS
        && now - currentCredential.payload.issued_at >= MINIMUM_CREDENTIAL_AGE_FOR_EARLY_RENEWAL_MS;
      const credentialRenewed = !credentialMatches || Boolean(shouldRenewSoon);
      let activeCredential = currentCredential;

      if (credentialRenewed) {
        const devicePublicKey = await QrCredentialService.getPublicKeySpkiBase64();
        const qrData = await ApiClient.request<{ credential: AuthorityCredential }>('/qr/generate', {
          params: {
            event_id: eventId,
            device_id: deviceId,
            device_public_key: devicePublicKey,
          },
        });
        await DatabaseService.storeQrCredential(qrData.credential);
        activeCredential = qrData.credential;
      }

      if (event.ends_at) {
        await DatabaseService.purgeIfEventExpired(new Date(event.ends_at).getTime());
      }

      await SecureStore.setItemAsync(CURRENT_EVENT_ID_KEY, String(eventId));
      await SecureStore.setItemAsync(CURRENT_EVENT_NAME_KEY, event.name);
      await SecureStore.setItemAsync(LAST_SYNC_AT_KEY, String(Date.now()));

      const tokenBinding = ApiClient.getTokenBinding();
      if (tokenBinding && activeCredential) {
        await OfflineSessionService.refreshProductionBinding({
          userId: credentialData.user.id,
          email: credentialData.user.email,
          eventId,
          deviceId,
          tokenBinding,
          credentialVersion: activeCredential.payload.credential_version,
        });
      }

      await ApiClient.request('/notifications/sync-heartbeat', {
        method: 'POST',
        body: { device_id: deviceId, app: 'pass', event_id: eventId, platform: Platform.OS },
      }).catch(() => undefined); // heartbeat is best-effort, never blocks sync

      return { success: true, eventId, eventName: event.name, userCount: 1, credentialRenewed };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
    }
  }
}

export const SyncService = new SyncServiceClass();
