import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { p256 } from '@noble/curves/p256';
import { User } from './DatabaseService';

export const QR_PROTOCOL_VERSION = 'verigate-qr-v2';
export const QR_PROTOCOL_V3 = 3 as const;
export const QR_V3_MAX_BYTES = 800;
export const QR_V3_MAX_VERSION = 20;
const PRIVATE_KEY = 'verigate_pass_presentation_private_key';
const LOCAL_AUTHORITY_REVOKED_KEY = 'verigate_pass_local_authority_revoked';
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

type InstalledQrEncoder = {
  create(value: string, options: { errorCorrectionLevel: 'M' }): {
    modules: { size: number };
  };
};

// This is the encoder bundled by react-native-qrcode-svg; preflighting the same
// implementation prevents publishing a value that the rendered component rejects.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installedQrEncoder = require('qrcode') as InstalledQrEncoder;

export interface CredentialAssignment {
  area_id: number;
  area_name: string;
  access_level_id: number;
  access_level_name: string;
  access_priority: number;
  valid_from: string;
  valid_until: string;
}

export interface AuthorityCredentialV2 {
  payload: {
    version: typeof QR_PROTOCOL_VERSION;
    credential_id: string;
    credential_version: string;
    user_id: number;
    email: string;
    name: string;
    event_id: number;
    device_id: string;
    device_public_key: string;
    assignments: CredentialAssignment[];
    issued_at: number;
    expires_at: number;
  };
  authority_signature: string;
  authority_public_key: string;
}

export interface AuthorityCredentialV3 {
  p: {
    v: typeof QR_PROTOCOL_V3;
    kid: string;
    cid: string;
    cg: number;
    uid: number;
    eid: number;
    did: string;
    rg: number;
    dpk: string;
    iat: number;
    exp: number;
  };
  s: string;
}

export type AuthorityCredential = AuthorityCredentialV2;
export type QrAuthorityCredential = AuthorityCredentialV2 | AuthorityCredentialV3;
export type LocallyStoredQrCredential = AuthorityCredentialV2 | (
  AuthorityCredentialV3 & {
    readonly payload: { credential_version: string };
  }
);

export interface QrCredentialContext {
  installation_id: string;
  registration_generation: number;
  active_authority_key: {
    kid: string;
    public_key: string;
  };
}

export interface QrPresentationPreflight {
  encoded: string;
  bytes: number;
  qrVersion: number;
}

export class QrPresentationError extends Error {
  constructor(
    public readonly code: 'credential_invalid' | 'payload_too_large' | 'qr_version_unsupported',
    message: string
  ) {
    super(message);
    this.name = 'QrPresentationError';
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function boundedBase64Url(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    return base64UrlToBytes(value).length === bytes;
  } catch {
    return false;
  }
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

async function digest(value: unknown): Promise<Uint8Array> {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonical(value),
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  return hexToBytes(hex);
}

class QrCredentialServiceClass {
  async revokeLocalAuthority(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(PRIVATE_KEY),
      SecureStore.setItemAsync(LOCAL_AUTHORITY_REVOKED_KEY, 'true'),
    ]);
  }

  async allowRegisteredAuthority(): Promise<void> {
    await SecureStore.deleteItemAsync(LOCAL_AUTHORITY_REVOKED_KEY);
  }

  private async requireLocallyAuthorized(): Promise<void> {
    if (await SecureStore.getItemAsync(LOCAL_AUTHORITY_REVOKED_KEY)) {
      throw new Error('Device registration is required before creating a QR presentation');
    }
  }

  private async privateKey(): Promise<string> {
    const stored = await SecureStore.getItemAsync(PRIVATE_KEY);
    if (stored && p256.utils.isValidPrivateKey(stored)) return stored;

    let key: Uint8Array;
    do {
      key = await Crypto.getRandomBytesAsync(32);
    } while (!p256.utils.isValidPrivateKey(key));
    const encoded = bytesToHex(key);
    await SecureStore.setItemAsync(PRIVATE_KEY, encoded);
    return encoded;
  }

  async getPublicKeySpkiBase64(): Promise<string> {
    const publicKey = p256.getPublicKey(await this.privateKey(), false);
    return bytesToBase64(hexToBytes(SPKI_PREFIX + bytesToHex(publicKey)));
  }

  async getPublicKeyPointBase64Url(): Promise<string> {
    return bytesToBase64Url(p256.getPublicKey(await this.privateKey(), false));
  }

  isV3Credential(credential: QrAuthorityCredential): credential is AuthorityCredentialV3 {
    return 'p' in credential && credential.p?.v === QR_PROTOCOL_V3;
  }

  credentialExpiresAtMs(credential: QrAuthorityCredential): number {
    return this.isV3Credential(credential)
      ? credential.p.exp * 1_000
      : credential.payload.expires_at;
  }

  credentialVersionIdentifier(credential: QrAuthorityCredential): string {
    return this.isV3Credential(credential)
      ? `${credential.p.kid}:${credential.p.cg}`
      : credential.payload.credential_version;
  }

  async validateV3Credential(
    raw: unknown,
    expected: {
      eventId: number;
      userId: number;
      deviceId: string;
      devicePublicKey: string;
      context: QrCredentialContext;
      now?: number;
    }
  ): Promise<AuthorityCredentialV3> {
    if (!exactObject(raw, ['p', 's'])) {
      throw new QrPresentationError('credential_invalid', 'Credential envelope is invalid; sync is required');
    }
    const payload = raw.p;
    if (!exactObject(payload, ['v', 'kid', 'cid', 'cg', 'uid', 'eid', 'did', 'rg', 'dpk', 'iat', 'exp'])) {
      throw new QrPresentationError('credential_invalid', 'Credential fields are invalid; sync is required');
    }
    if (
      payload.v !== QR_PROTOCOL_V3 ||
      typeof payload.kid !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(payload.kid) ||
      !boundedBase64Url(payload.cid, 16) ||
      !Number.isSafeInteger(payload.cg) || Number(payload.cg) <= 0 ||
      !Number.isSafeInteger(payload.uid) || Number(payload.uid) <= 0 ||
      !Number.isSafeInteger(payload.eid) || Number(payload.eid) <= 0 ||
      typeof payload.did !== 'string' ||
      !/^pass-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.did) ||
      !Number.isSafeInteger(payload.rg) || Number(payload.rg) <= 0 ||
      !boundedBase64Url(payload.dpk, 65) ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      !boundedBase64Url(raw.s, 64)
    ) {
      throw new QrPresentationError('credential_invalid', 'Credential values are invalid; sync is required');
    }
    const credential = raw as unknown as AuthorityCredentialV3;
    const nowSeconds = Math.floor((expected.now ?? Date.now()) / 1000);
    if (
      credential.p.eid !== expected.eventId ||
      credential.p.uid !== expected.userId ||
      credential.p.did !== expected.deviceId ||
      credential.p.dpk !== expected.devicePublicKey ||
      credential.p.rg !== expected.context.registration_generation ||
      credential.p.kid !== expected.context.active_authority_key.kid ||
      expected.context.installation_id !== expected.deviceId ||
      credential.p.exp < credential.p.iat ||
      credential.p.iat > nowSeconds + 60 ||
      credential.p.exp <= nowSeconds
    ) {
      throw new QrPresentationError('credential_invalid', 'Credential does not match this Pass session; sync is required');
    }
    try {
      if (!p256.verify(
        base64UrlToBytes(credential.s),
        await digest(credential.p),
        base64UrlToBytes(expected.context.active_authority_key.public_key)
      )) {
        throw new Error('invalid signature');
      }
    } catch {
      throw new QrPresentationError('credential_invalid', 'Credential authority signature is invalid; sync is required');
    }
    return credential;
  }

  preflightV3Presentation(encoded: string): QrPresentationPreflight {
    const bytes = new TextEncoder().encode(encoded).length;
    if (bytes > QR_V3_MAX_BYTES) {
      throw new QrPresentationError(
        'payload_too_large',
        'QR credential is too large to render safely; sync again or contact event support'
      );
    }
    let size: number;
    try {
      size = installedQrEncoder.create(encoded, { errorCorrectionLevel: 'M' }).modules.size;
    } catch {
      throw new QrPresentationError(
        'qr_version_unsupported',
        'QR credential cannot be encoded safely; sync again or contact event support'
      );
    }
    const qrVersion = (size - 17) / 4;
    if (!Number.isInteger(qrVersion) || qrVersion < 1 || qrVersion > QR_V3_MAX_VERSION) {
      throw new QrPresentationError(
        'qr_version_unsupported',
        'QR credential exceeds the supported render version; sync again or contact event support'
      );
    }
    return { encoded, bytes, qrVersion };
  }

  async createPresentation(
    credential: QrAuthorityCredential,
    now = Date.now(),
    context?: QrCredentialContext
  ): Promise<string> {
    await this.requireLocallyAuthorized();
    if (this.isV3Credential(credential)) {
      if (!context) {
        throw new QrPresentationError('credential_invalid', 'Credential trust context is missing; sync is required');
      }
      await this.validateV3Credential(credential, {
        eventId: credential.p.eid,
        userId: credential.p.uid,
        deviceId: credential.p.did,
        devicePublicKey: await this.getPublicKeyPointBase64Url(),
        context,
        now,
      });
      const nowSeconds = Math.floor(now / 1000);
      if (credential.p.exp <= nowSeconds) {
        throw new Error('Credential has expired; sync is required');
      }
      const nonce = await Crypto.getRandomBytesAsync(16);
      if (nonce.length !== 16) throw new Error('Unable to create a secure presentation nonce');
      const unsigned = {
        v: QR_PROTOCOL_V3,
        c: credential,
        iat: nowSeconds,
        exp: Math.min(nowSeconds + 60, credential.p.exp),
        n: bytesToBase64Url(nonce),
      };
      const signature = p256.sign(
        await digest(unsigned),
        await this.privateKey()
      ).toCompactRawBytes();
      const encoded = canonical({ ...unsigned, s: bytesToBase64Url(signature) });
      return this.preflightV3Presentation(encoded).encoded;
    }
    if (credential.payload.expires_at <= now) throw new Error('Credential has expired; sync is required');
    const payload = {
      version: QR_PROTOCOL_VERSION,
      credential,
      issued_at: now,
      expires_at: now + 60_000,
      nonce: Crypto.randomUUID(),
    };
    const signature = p256.sign(await digest(payload), await this.privateKey()).toDERRawBytes();
    return JSON.stringify({ payload, device_signature: bytesToBase64(signature) });
  }

  createDemoPresentation(user: User, eventId: number): string {
    return JSON.stringify({
      version: 'verigate-demo-v1',
      demo: true,
      event_id: eventId,
      user_id: user.id,
      email: user.email,
      name: user.name,
      assignments: user.assignments ?? [],
      expires_at: Date.now() + 60_000,
    });
  }
}

export const QrCredentialService = new QrCredentialServiceClass();
