/* eslint-disable import/first */
const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureStore.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecureStore.delete(key); }),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytesAsync: jest.fn(async (length: number) => length === 16
    ? Uint8Array.from({ length: 16 }, (_, index) => index)
    : Uint8Array.from([...new Array(31).fill(0), 1])),
  randomUUID: jest.fn(() => 'presentation-nonce'),
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => jest.requireActual('crypto').createHash('sha256').update(value).digest('hex')),
}));

import {
  AuthorityCredential,
  AuthorityCredentialV3,
  QrCredentialContext,
  QrCredentialService,
  QR_PROTOCOL_VERSION,
} from '../QrCredentialService';
import { p256 } from '@noble/curves/p256';
import qrV3Fixture from '../__fixtures__/qr-v3-contract.json';

function canonicalV3(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalV3).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalV3((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixtureDigest(value: unknown): Uint8Array {
  return jest.requireActual('crypto').createHash('sha256').update(canonicalV3(value)).digest();
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function credentialV3(nowSeconds = 10_000): Promise<{
  credential: AuthorityCredentialV3;
  context: QrCredentialContext;
}> {
  const authorityKey = Uint8Array.from([...new Array(31).fill(0), 2]);
  const devicePublicKey = await QrCredentialService.getPublicKeyPointBase64Url();
  const payload = {
    v: 3 as const,
    kid: 'qr-active',
    cid: base64Url(Uint8Array.from({ length: 16 }, (_, index) => index)),
    cg: 4,
    uid: 7,
    eid: 3,
    did: 'pass-550e8400-e29b-41d4-a716-446655440000',
    rg: 2,
    dpk: devicePublicKey,
    iat: nowSeconds,
    exp: nowSeconds + 86_400,
  };
  return {
    credential: {
      p: payload,
      s: base64Url(p256.sign(fixtureDigest(payload), authorityKey).toCompactRawBytes()),
    },
    context: {
      installation_id: payload.did,
      registration_generation: payload.rg,
      active_authority_key: {
        kid: payload.kid,
        public_key: base64Url(p256.getPublicKey(authorityKey, false)),
      },
    },
  };
}

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

  it('makes cached credentials unusable until a successful re-registration', async () => {
    await QrCredentialService.revokeLocalAuthority();
    await expect(QrCredentialService.createPresentation(credential(100_000), 10_000))
      .rejects.toThrow(/registration is required/i);

    await QrCredentialService.allowRegisteredAuthority();
    await expect(QrCredentialService.createPresentation(credential(100_000), 10_000))
      .resolves.toEqual(expect.any(String));
  });

  it('shares the fixed compact v3 golden vector and adverse matrix', () => {
    const encoded = canonicalV3({
      ...qrV3Fixture.valid.presentation_unsigned,
      s: qrV3Fixture.valid.device_signature,
    });
    expect(p256.verify(
      Buffer.from(qrV3Fixture.valid.authority_signature, 'base64url'),
      fixtureDigest(qrV3Fixture.valid.credential_payload),
      Buffer.from(qrV3Fixture.verification.authority_public_key, 'base64url')
    )).toBe(true);
    expect(p256.verify(
      Buffer.from(qrV3Fixture.valid.device_signature, 'base64url'),
      fixtureDigest(qrV3Fixture.valid.presentation_unsigned),
      Buffer.from(qrV3Fixture.verification.device_public_key, 'base64url')
    )).toBe(true);
    expect(Buffer.byteLength(encoded)).toBe(535);
    expect(qrV3Fixture.mutations).toHaveLength(23);
    expect(qrV3Fixture.mutations.find(({ id }) => id === 'repeated-nonce'))
      .toMatchObject({ decision: 'allow_and_correlate' });
  });

  it('validates, signs, and preflights a compact v3 presentation with no PII projection', async () => {
    const value = await credentialV3();
    await expect(QrCredentialService.validateV3Credential(value.credential, {
      eventId: 3,
      userId: 7,
      deviceId: value.context.installation_id,
      devicePublicKey: value.credential.p.dpk,
      context: value.context,
      now: 10_000_000,
    })).resolves.toEqual(value.credential);

    const encoded = await QrCredentialService.createPresentation(
      value.credential,
      10_000_000,
      value.context
    );
    const presentation = JSON.parse(encoded);
    const unsigned = {
      v: presentation.v,
      c: presentation.c,
      iat: presentation.iat,
      exp: presentation.exp,
      n: presentation.n,
    };
    expect(Object.keys(presentation).sort()).toEqual(['c', 'exp', 'iat', 'n', 's', 'v']);
    expect(presentation.c.p).not.toHaveProperty('assignments');
    expect(presentation.c.p).not.toHaveProperty('email');
    expect(presentation.c.p).not.toHaveProperty('name');
    expect(Buffer.from(presentation.s, 'base64url')).toHaveLength(64);
    expect(p256.verify(
      Buffer.from(presentation.s, 'base64url'),
      fixtureDigest(unsigned),
      Buffer.from(value.credential.p.dpk, 'base64url')
    )).toBe(true);
    expect(QrCredentialService.preflightV3Presentation(encoded)).toMatchObject({
      bytes: Buffer.byteLength(encoded),
      qrVersion: expect.any(Number),
    });
  });

  it('rejects byte and installed-encoder version overflow before rendering', () => {
    expect(() => QrCredentialService.preflightV3Presentation('x'.repeat(801)))
      .toThrow(/too large/i);
    expect(() => QrCredentialService.preflightV3Presentation('x'.repeat(700)))
      .toThrow(/render version/i);
  });

  it('rejects credentials after authority rotation or registration generation change', async () => {
    const value = await credentialV3();
    await expect(QrCredentialService.validateV3Credential(value.credential, {
      eventId: 3,
      userId: 7,
      deviceId: value.context.installation_id,
      devicePublicKey: value.credential.p.dpk,
      context: {
        ...value.context,
        active_authority_key: {
          ...value.context.active_authority_key,
          kid: 'qr-rotated',
        },
      },
      now: 10_000_000,
    })).rejects.toThrow(/does not match/i);

    await expect(QrCredentialService.validateV3Credential(value.credential, {
      eventId: 3,
      userId: 7,
      deviceId: value.context.installation_id,
      devicePublicKey: value.credential.p.dpk,
      context: {
        ...value.context,
        registration_generation: 3,
      },
      now: 10_000_000,
    })).rejects.toThrow(/does not match/i);
  });
});
