/* eslint-disable import/first */
const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureStore.set(key, value); }),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytesAsync: jest.fn(async () => Uint8Array.from([...new Array(31).fill(0), 1])),
  randomUUID: jest.fn(() => 'presentation-nonce'),
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => jest.requireActual('crypto').createHash('sha256').update(value).digest('hex')),
}));

import { AuthorityCredential, QrCredentialService, QR_PROTOCOL_VERSION } from '../QrCredentialService';

function credential(expiresAt: number): AuthorityCredential {
  return {
    payload: {
      version: QR_PROTOCOL_VERSION,
      credential_id: 'credential-1',
      credential_version: 'version-1',
      user_id: 7,
      email: 'vip@example.com',
      name: 'VIP Guest',
      event_id: 3,
      device_id: 'device-1',
      device_public_key: '',
      assignments: [],
      issued_at: 1_000,
      expires_at: expiresAt,
    },
    authority_signature: 'authority-signature',
    authority_public_key: 'authority-key',
  };
}

describe('QrCredentialService', () => {
  beforeEach(() => mockSecureStore.clear());

  it('creates a short-lived device-signed v2 presentation', async () => {
    const value = credential(100_000);
    value.payload.device_public_key = await QrCredentialService.getPublicKeySpkiBase64();
    const encoded = await QrCredentialService.createPresentation(value, 10_000);
    const presentation = JSON.parse(encoded);

    expect(presentation.payload.version).toBe(QR_PROTOCOL_VERSION);
    expect(presentation.payload.expires_at).toBe(70_000);
    expect(presentation.payload.nonce).toBe('presentation-nonce');
    expect(presentation.device_signature).toBeTruthy();
  });

  it('does not present an expired authority credential', async () => {
    await expect(QrCredentialService.createPresentation(credential(9_999), 10_000))
      .rejects.toThrow('Credential has expired');
  });
});
