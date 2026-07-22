import * as SecureStore from 'expo-secure-store';

const KEY = 'verigate_pass_offline_session_v2';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SCHEMA_VERSION = 3;

export interface OfflineSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  userId: number;
  email: string;
  eventId: number;
  mode: 'production' | 'demo';
  deviceId: string;
  tokenBinding: string | null;
  credentialVersion: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface OfflineSessionBindings {
  deviceId: string;
  tokenBinding: string | null;
  credentialVersion: string | null;
}

export interface OfflineSessionExpectation extends OfflineSessionBindings {
  userId: number;
  email: string;
  eventId: number;
}

class OfflineSessionServiceClass {
  async create(
    userId: number,
    email: string,
    eventId: number,
    mode: OfflineSession['mode'],
    bindings: OfflineSessionBindings
  ): Promise<void> {
    if (!bindings.deviceId) throw new Error('Offline session requires a device binding');
    if (mode === 'production' && (!bindings.tokenBinding || !bindings.credentialVersion)) {
      throw new Error('Production offline session requires token and credential bindings');
    }
    const issuedAt = Date.now();
    await SecureStore.setItemAsync(KEY, JSON.stringify({
      schemaVersion: SESSION_SCHEMA_VERSION,
      userId,
      email: email.toLowerCase(),
      eventId,
      mode,
      deviceId: bindings.deviceId,
      tokenBinding: mode === 'production' ? bindings.tokenBinding : null,
      credentialVersion: mode === 'production' ? bindings.credentialVersion : null,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_MS,
    } satisfies OfflineSession));
  }

  private async read(email?: string): Promise<OfflineSession | null> {
    const stored = await SecureStore.getItemAsync(KEY);
    if (!stored) return null;
    try {
      const session = JSON.parse(stored) as OfflineSession;
      if (
        session.schemaVersion !== SESSION_SCHEMA_VERSION ||
        !Number.isInteger(session.userId) ||
        typeof session.email !== 'string' ||
        !Number.isFinite(session.eventId) ||
        (session.mode !== 'production' && session.mode !== 'demo') ||
        !session.deviceId ||
        !Number.isFinite(session.issuedAt) ||
        !Number.isFinite(session.expiresAt) ||
        (session.mode === 'production' && (!session.tokenBinding || !session.credentialVersion)) ||
        session.expiresAt <= Date.now() ||
        (email && session.email !== email.toLowerCase())
      ) {
        await this.clear();
        return null;
      }
      return session;
    } catch {
      await this.clear();
      return null;
    }
  }

  async getMetadata(email?: string): Promise<OfflineSession | null> {
    return this.read(email);
  }

  async getValid(expected: OfflineSessionExpectation): Promise<OfflineSession | null> {
    const session = await this.read(expected.email);
    if (!session) return null;
    const identityMatches = session.userId === expected.userId && session.eventId === expected.eventId;
    const deviceMatches = session.deviceId === expected.deviceId;
    const productionBindingsMatch = session.mode !== 'production' || (
      !!expected.tokenBinding &&
      !!expected.credentialVersion &&
      session.tokenBinding === expected.tokenBinding &&
      session.credentialVersion === expected.credentialVersion
    );
    if (!identityMatches || !deviceMatches || !productionBindingsMatch) {
      await this.clear();
      return null;
    }
    return session;
  }

  async refreshProductionBinding(expected: OfflineSessionExpectation): Promise<void> {
    const session = await this.read(expected.email);
    if (
      !session ||
      session.mode !== 'production' ||
      session.userId !== expected.userId ||
      session.deviceId !== expected.deviceId ||
      !expected.tokenBinding ||
      !expected.credentialVersion ||
      session.tokenBinding !== expected.tokenBinding
    ) {
      return;
    }
    await SecureStore.setItemAsync(KEY, JSON.stringify({
      ...session,
      eventId: expected.eventId,
      credentialVersion: expected.credentialVersion,
    } satisfies OfflineSession));
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  }
}

export const OfflineSessionService = new OfflineSessionServiceClass();
