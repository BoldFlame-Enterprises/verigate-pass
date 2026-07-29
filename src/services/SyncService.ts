import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  ApiClient,
  deviceControlReason,
  DeviceControlReason,
} from './ApiClient';
import { DatabaseService, User } from './DatabaseService';
import {
  AuthorityCredential,
  AuthorityCredentialV3,
  QrAuthorityCredential,
  QrCredentialContext,
  QrCredentialService,
} from './QrCredentialService';
import { OfflineSessionService } from './OfflineSessionService';
import { DeviceIdentityService } from './DeviceIdentityService';

const CURRENT_EVENT_ID_KEY = 'verigate_pass_event_id';
const CURRENT_EVENT_NAME_KEY = 'verigate_pass_event_name';
const LAST_SYNC_AT_KEY = 'verigate_pass_last_sync_at';

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
  deviceControlReason?: DeviceControlReason;
  error?: string;
}

const CREDENTIAL_RENEWAL_WINDOW_MS = 60_000;

interface CredentialProjection {
  contract_version: 'event-user-v3';
  user: User;
  qr_credential_context: QrCredentialContext;
}

interface LegacyCredentialProjection {
  contract_version: 'event-user-v2';
  user: User;
}

interface GeneratedCredential {
  contract_version: 'qr-credential-v3';
  credential: AuthorityCredentialV3;
  active_authority_key_id: string;
  registration_generation: number;
  expires_at: number;
}

function sameAssignments(
  left: AuthorityCredential['payload']['assignments'],
  right: User['assignments']
): boolean {
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
  private inFlight: Promise<SyncResult> | null = null;

  async getDeviceId(): Promise<string> {
    return DeviceIdentityService.getOrCreate();
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
      const deviceId = await this.getDeviceId();
      if (!ApiClient.hasDeviceSession()) {
        await ApiClient.registerDeviceSession(
          eventId,
          deviceId,
          Platform.OS === 'ios' ? 'ios' : 'android'
        );
        await QrCredentialService.allowRegisteredAuthority();
      }

      const credentialData = await ApiClient.request<
        CredentialProjection | LegacyCredentialProjection
      >('/sync/my-credential', { params: { event_id: eventId } });
      await DatabaseService.upsertSyncedUsers([credentialData.user]);

      const currentCredential = await DatabaseService.getQrCredential?.(eventId, credentialData.user.id) ?? null;
      const now = Date.now();
      let credentialMatches = false;
      let activeCredential: QrAuthorityCredential | null = currentCredential;
      let credentialExpiresAt = 0;
      let devicePublicKey: string;
      if (credentialData.contract_version === 'event-user-v3') {
        if (credentialData.qr_credential_context.installation_id !== deviceId) {
          throw new Error('Credential renewal context does not match this Pass installation');
        }
        devicePublicKey = await QrCredentialService.getPublicKeyPointBase64Url();
        if (currentCredential && 'p' in currentCredential) {
          try {
            await QrCredentialService.validateV3Credential(currentCredential, {
              eventId,
              userId: credentialData.user.id,
              deviceId,
              devicePublicKey,
              context: credentialData.qr_credential_context,
              now,
            });
            credentialMatches = true;
          } catch {
            credentialMatches = false;
          }
        }
        credentialExpiresAt = currentCredential
          ? QrCredentialService.credentialExpiresAtMs(currentCredential)
          : 0;
      } else {
        devicePublicKey = await QrCredentialService.getPublicKeySpkiBase64();
        if (currentCredential && !('p' in currentCredential)) {
          credentialMatches =
            currentCredential.payload.event_id === eventId &&
            currentCredential.payload.user_id === credentialData.user.id &&
            currentCredential.payload.device_id === deviceId &&
            currentCredential.payload.email === credentialData.user.email &&
            currentCredential.payload.name === credentialData.user.name &&
            sameAssignments(
              currentCredential.payload.assignments,
              credentialData.user.assignments
            );
          credentialExpiresAt = currentCredential.payload.expires_at;
        }
      }
      const shouldRenewSoon = currentCredential &&
        credentialExpiresAt - now <= CREDENTIAL_RENEWAL_WINDOW_MS;
      const credentialRenewed = !credentialMatches || Boolean(shouldRenewSoon);

      if (credentialRenewed) {
        if (credentialData.contract_version === 'event-user-v3') {
          const qrData = await ApiClient.request<GeneratedCredential>('/qr/generate', {
            params: {
              event_id: eventId,
              device_id: deviceId,
              device_public_key: devicePublicKey,
              protocol_version: 3,
            },
          });
          if (
            qrData.contract_version !== 'qr-credential-v3' ||
            qrData.active_authority_key_id !==
              credentialData.qr_credential_context.active_authority_key.kid ||
            qrData.registration_generation !==
              credentialData.qr_credential_context.registration_generation
          ) {
            throw new Error('Generated credential metadata does not match the active Pass session');
          }
          activeCredential = await QrCredentialService.validateV3Credential(qrData.credential, {
            eventId,
            userId: credentialData.user.id,
            deviceId,
            devicePublicKey,
            context: credentialData.qr_credential_context,
            now,
          });
          await DatabaseService.storeQrCredential(
            activeCredential,
            credentialData.qr_credential_context
          );
        } else {
          const qrData = await ApiClient.request<{ credential: AuthorityCredential }>(
            '/qr/generate',
            {
              params: {
                event_id: eventId,
                device_id: deviceId,
                device_public_key: devicePublicKey,
              },
            }
          );
          activeCredential = qrData.credential;
          await DatabaseService.storeQrCredential(activeCredential);
        }
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
          credentialVersion: 'p' in activeCredential
            ? QrCredentialService.credentialVersionIdentifier(activeCredential)
            : activeCredential.payload.credential_version,
        });
      }

      await ApiClient.request('/notifications/sync-heartbeat', {
        method: 'POST',
        body: { device_id: deviceId, app: 'pass', event_id: eventId, platform: Platform.OS },
      }).catch(() => undefined); // heartbeat is best-effort, never blocks sync

      return { success: true, eventId, eventName: event.name, userCount: 1, credentialRenewed };
    } catch (error) {
      const reason = deviceControlReason(error);
      return {
        success: false,
        ...(reason ? { deviceControlReason: reason } : {}),
        error: error instanceof Error ? error.message : 'Sync failed',
      };
    }
  }
}

export const SyncService = new SyncServiceClass();
