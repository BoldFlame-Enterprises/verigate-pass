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
import crypto from 'node:crypto';
import { ApiClient } from '../src/services/ApiClient';
import { OfflineSessionService } from '../src/services/OfflineSessionService';
import { QrCredentialContext, QrCredentialService } from '../src/services/QrCredentialService';

const live = process.env.COMPAT_LIVE === '1' ? it : it.skip;

describe('Pass production-shared convergence compatibility flow', () => {
  live('synchronizes revoked access and applies exact client expiry boundaries', async () => {
    const inputPath = process.env.COMPAT_CONVERGENCE_INPUT;
    const outputPath = process.env.COMPAT_PASS_CONVERGENCE_OUTPUT;
    if (!inputPath || !outputPath) throw new Error('Pass convergence paths are required');
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const eventId = Number(input.fixture.event_id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid event ID');

    await ApiClient.clearTokens();
    const user = await ApiClient.login('vip@test.com', 'password123');
    const installationId = `pass-${crypto.randomUUID()}`;
    await ApiClient.registerDeviceSession(eventId, installationId, 'android');
    const projection = await ApiClient.request<{
      contract_version: string;
      user: { id: number; event_id: number; assignments: unknown[] };
      qr_credential_context: QrCredentialContext;
    }>('/sync/my-credential', { params: { event_id: eventId } });
    expect(projection.user.assignments).toHaveLength(0);

    const publicKey = await QrCredentialService.getPublicKeyPointBase64Url();
    const issued = await ApiClient.request<any>('/qr/generate', {
      params: {
        event_id: eventId,
        device_id: installationId,
        device_public_key: publicKey,
        protocol_version: 3,
      },
    });
    const credentialExpiry = Number(issued.credential.p.exp) * 1000;
    await expect(QrCredentialService.createPresentation(
      issued.credential,
      credentialExpiry - 1,
      projection.qr_credential_context
    )).resolves.toEqual(expect.any(String));
    await expect(QrCredentialService.createPresentation(
      issued.credential,
      credentialExpiry,
      projection.qr_credential_context
    )).rejects.toThrow(/sync is required/);
    await expect(QrCredentialService.createPresentation(
      issued.credential,
      credentialExpiry + 1,
      projection.qr_credential_context
    )).rejects.toThrow(/sync is required/);

    const sessionStart = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(sessionStart);
    const bindings = {
      deviceId: installationId,
      tokenBinding: ApiClient.getTokenBinding(),
      credentialVersion: QrCredentialService.credentialVersionIdentifier(issued.credential),
    };
    await OfflineSessionService.create(user.id, user.email, eventId, 'production', bindings);
    const rawSession = mockStore.get('verigate_pass_offline_session_v2');
    if (!rawSession) throw new Error('Offline session fixture is unavailable');
    const session = JSON.parse(rawSession);
    dateNow.mockReturnValue(session.expiresAt - 1);
    const before = await OfflineSessionService.getValid({
      userId: user.id, email: user.email, eventId, ...bindings,
    });
    mockStore.set('verigate_pass_offline_session_v2', rawSession);
    dateNow.mockReturnValue(session.expiresAt);
    const at = await OfflineSessionService.getValid({
      userId: user.id, email: user.email, eventId, ...bindings,
    });
    mockStore.set('verigate_pass_offline_session_v2', rawSession);
    dateNow.mockReturnValue(session.expiresAt + 1);
    const after = await OfflineSessionService.getValid({
      userId: user.id, email: user.email, eventId, ...bindings,
    });
    dateNow.mockRestore();

    expect(before).not.toBeNull();
    expect(at).toBeNull();
    expect(after).toBeNull();
    await fs.writeFile(outputPath, JSON.stringify({
      projection_contract: projection.contract_version,
      assignment_count: projection.user.assignments.length,
      credential_expiry_boundary: { before: 'allowed', at: 'denied', after: 'denied' },
      offline_session_boundary: {
        before: before !== null,
        at: at !== null,
        after: after !== null,
      },
      trace: ApiClient.getLastRequestTrace(),
    }, null, 2) + '\n');
  }, 60_000);
});
