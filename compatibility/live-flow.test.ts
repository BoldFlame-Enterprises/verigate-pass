/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('expo-crypto', () => {
  const crypto = require('node:crypto');
  return {
    randomUUID: () => crypto.randomUUID(),
    getRandomBytesAsync: async (size: number) => new Uint8Array(crypto.randomBytes(size)),
    digestStringAsync: async (_algorithm: string, value: string) =>
      crypto.createHash('sha256').update(value).digest('hex'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
  };
});
jest.mock('../src/config', () => ({ API_BASE_URL: process.env.COMPAT_BACKEND_URL }));

import fs from 'node:fs/promises';
import { ApiClient } from '../src/services/ApiClient';
import { QrCredentialContext, QrCredentialService } from '../src/services/QrCredentialService';

const live = process.env.COMPAT_LIVE === '1' ? it : it.skip;

describe('Pass production-shared compatibility flow', () => {
  live('authenticates, synchronizes, and creates a bounded v3 presentation', async () => {
    const output = process.env.COMPAT_PASS_OUTPUT;
    const eventId = Number(process.env.COMPAT_EVENT_ID);
    if (!output || !Number.isSafeInteger(eventId)) throw new Error('Pass compatibility environment is incomplete');

    await ApiClient.clearTokens();
    const user = await ApiClient.login('vip@test.com', 'password123');
    const installationId = `pass-${require('node:crypto').randomUUID()}`;
    const registration = await ApiClient.registerDeviceSession(eventId, installationId, 'android');
    const projection = await ApiClient.request<{
      contract_version: string;
      user: { id: number; event_id: number; assignments: unknown[] };
      qr_credential_context: QrCredentialContext;
    }>('/sync/my-credential', { params: { event_id: eventId } });
    const devicePublicKey = await QrCredentialService.getPublicKeyPointBase64Url();
    const issued = await ApiClient.request<any>('/qr/generate', {
      params: {
        event_id: eventId,
        device_id: installationId,
        device_public_key: devicePublicKey,
        protocol_version: 3,
      },
    });
    const presentation = await QrCredentialService.createPresentation(
      issued.credential,
      Date.now(),
      projection.qr_credential_context
    );
    const preflight = QrCredentialService.preflightV3Presentation(presentation);

    expect(user.id).toBe(projection.user.id);
    expect(registration.event_id).toBe(eventId);
    expect(projection.contract_version).toBe('event-user-v3');
    expect(projection.user.assignments.length).toBeGreaterThan(0);
    expect(preflight.bytes).toBeLessThanOrEqual(800);

    await fs.writeFile(output, JSON.stringify({
      event_id: eventId,
      user_id: user.id,
      installation_id: installationId,
      registration_generation: registration.session_generation,
      projection_contract: projection.contract_version,
      projection,
      credential: issued.credential,
      presentation,
      presentation_bytes: preflight.bytes,
      qr_version: preflight.qrVersion,
      trace: ApiClient.getLastRequestTrace(),
    }) + '\n');
  }, 60_000);
});
