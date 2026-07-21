import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { p256 } from '@noble/curves/p256';
import { User } from './DatabaseService';

export const QR_PROTOCOL_VERSION = 'verigate-qr-v2';
const PRIVATE_KEY = 'verigate_pass_presentation_private_key';
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

export interface CredentialAssignment {
  area_id: number;
  area_name: string;
  access_level_id: number;
  access_level_name: string;
  access_priority: number;
  valid_from: string;
  valid_until: string;
}

export interface AuthorityCredential {
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

async function digest(value: unknown): Promise<Uint8Array> {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonical(value),
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  return hexToBytes(hex);
}

class QrCredentialServiceClass {
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

  async createPresentation(credential: AuthorityCredential, now = Date.now()): Promise<string> {
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
