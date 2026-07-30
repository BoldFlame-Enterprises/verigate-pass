import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_pass_access_token';
const REFRESH_TOKEN_KEY = 'verigate_pass_refresh_token';
const TOKEN_BINDING_KEY = 'verigate_pass_token_binding';
const SESSION_KIND_KEY = 'verigate_pass_session_kind';
const DEVICE_EVENT_ID_KEY = 'verigate_pass_device_event_id';
const LOGIN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

export interface BackendUser {
  id: number;
  email: string;
  name: string;
  phone: string;
  role: string;
  is_active: boolean;
}

export interface DeviceRegistration {
  id: number;
  event_id: number;
  app: 'pass';
  installation_id: string;
  state: 'active' | 'deregistered' | 'blacklisted';
  session_generation: number;
  version: number;
}

interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  code?: string;
}

type SessionKind = 'account' | 'device';
export type ApiFailureKind = 'timeout' | 'network' | 'session' | 'validation' | 'server';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly kind: ApiFailureKind = status === 401 || status === 403
      ? 'session'
      : status >= 400 && status < 500
        ? 'validation'
        : 'server'
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function fetchJsonWithDeadline<T>(
  url: string,
  init: Record<string, unknown>,
  timeoutMs: number
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; json: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const json = await response.json() as T;
    return { response, json };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiRequestError(0, 'REQUEST_TIMEOUT', 'Request timed out', 'timeout'));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(
      0,
      'NETWORK_ERROR',
      error instanceof Error ? error.message : 'Network request failed',
      'network'
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DeviceControlReason = 'deregistered' | 'blacklisted';

export function deviceControlReason(error: unknown): DeviceControlReason | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'DEVICE_BLACKLISTED') return 'blacklisted';
  if (
    error.code === 'DEVICE_DEREGISTERED' ||
    error.code === 'DEVICE_SESSION_STALE' ||
    error.code === 'DEVICE_SESSION_INVALID'
  ) {
    return 'deregistered';
  }
  return null;
}

class ApiClientClass {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenBinding: string | null = null;
  private sessionKind: SessionKind | null = null;
  private deviceEventId: number | null = null;

  async loadTokens(): Promise<void> {
    const [accessToken, refreshToken, tokenBinding, sessionKind, deviceEventId] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.getItemAsync(TOKEN_BINDING_KEY),
      SecureStore.getItemAsync(SESSION_KIND_KEY),
      SecureStore.getItemAsync(DEVICE_EVENT_ID_KEY),
    ]);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenBinding = tokenBinding;
    this.sessionKind = sessionKind === 'account' || sessionKind === 'device'
      ? sessionKind
      : null;
    const parsedEventId = Number(deviceEventId);
    this.deviceEventId = Number.isSafeInteger(parsedEventId) && parsedEventId > 0
      ? parsedEventId
      : null;
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  hasDeviceSession(): boolean {
    return !!this.accessToken && this.sessionKind === 'device';
  }

  getTokenBinding(): string | null {
    return this.tokenBinding;
  }

  getDeviceEventId(): number | null {
    return this.sessionKind === 'device' ? this.deviceEventId : null;
  }

  private async setTokens(
    accessToken: string,
    refreshToken: string,
    options: { rotateBinding?: boolean; kind?: SessionKind } = {}
  ): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (options.rotateBinding || !this.tokenBinding) {
      this.tokenBinding = Crypto.randomUUID();
    }
    if (options.kind) this.sessionKind = options.kind;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
      SecureStore.setItemAsync(TOKEN_BINDING_KEY, this.tokenBinding),
      SecureStore.setItemAsync(SESSION_KIND_KEY, this.sessionKind ?? 'account'),
    ]);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenBinding = null;
    this.sessionKind = null;
    this.deviceEventId = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(TOKEN_BINDING_KEY),
      SecureStore.deleteItemAsync(SESSION_KIND_KEY),
      SecureStore.deleteItemAsync(DEVICE_EVENT_ID_KEY),
    ]);
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) {
        await fetchJsonWithDeadline(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.accessToken}` },
        }, HEARTBEAT_TIMEOUT_MS).catch(() => undefined);
      }
    } finally {
      await this.clearTokens();
    }
  }

  async login(email: string, password: string): Promise<BackendUser> {
    const { response, json } = await fetchJsonWithDeadline<APIResponse<{
      user: BackendUser;
      accessToken: string;
      refreshToken: string;
    }>>(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client_kind: 'pass' }),
    }, LOGIN_TIMEOUT_MS);
    if (!response.ok || !json.success || !json.data) {
      throw new ApiRequestError(
        response.status,
        json.code,
        json.error || 'Login failed'
      );
    }
    await this.setTokens(json.data.accessToken, json.data.refreshToken, {
      rotateBinding: true,
      kind: 'account',
    });
    return json.data.user;
  }

  async registerDeviceSession(
    eventId: number,
    installationId: string,
    platform: 'android' | 'ios'
  ): Promise<DeviceRegistration> {
    const data = await this.request<{
      registration: DeviceRegistration;
      accessToken: string;
      refreshToken: string;
    }>('/devices/session', {
      method: 'POST',
      timeoutMs: LOGIN_TIMEOUT_MS,
      idempotencyKey: `${installationId}:pass:${eventId}`,
      body: {
        event_id: eventId,
        app: 'pass',
        installation_id: installationId,
        platform,
      },
    });
    if (data.registration.event_id !== eventId || data.registration.app !== 'pass') {
      throw new ApiRequestError(
        409,
        'DEVICE_EVENT_BINDING_MISMATCH',
        'Registered device session does not match the selected event'
      );
    }
    await this.setTokens(data.accessToken, data.refreshToken, { kind: 'device' });
    this.deviceEventId = data.registration.event_id;
    await SecureStore.setItemAsync(DEVICE_EVENT_ID_KEY, String(data.registration.event_id));
    return data.registration;
  }

  async getDeviceState(): Promise<unknown> {
    return this.request('/devices/state');
  }

  private async refresh(deadlineAt: number): Promise<boolean> {
    if (!this.refreshToken) return false;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ApiRequestError(0, 'REQUEST_TIMEOUT', 'Session refresh timed out', 'timeout');
    }
    const { response, json } = await fetchJsonWithDeadline<
      APIResponse<{ accessToken: string; refreshToken: string }>
    >(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    }, remaining);
    if (!response.ok || !json.success || !json.data) {
      throw new ApiRequestError(
        response.status,
        json.code,
        json.error || 'Session refresh failed'
      );
    }
    await this.setTokens(json.data.accessToken, json.data.refreshToken);
    return true;
  }

  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number>;
      timeoutMs?: number;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    if (!this.accessToken) throw new Error('Not authenticated');

    const query = options.params
      ? '?' + new URLSearchParams(
        Object.entries(options.params).map(([key, value]) => [key, String(value)])
      ).toString()
      : '';
    const url = `${API_BASE_URL}${path}${query}`;
    const deadlineAt = Date.now() + (options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const doFetch = async () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new ApiRequestError(0, 'REQUEST_TIMEOUT', `Request timed out: ${path}`, 'timeout');
      }
      return fetchJsonWithDeadline<APIResponse<T>>(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      }, remaining);
    };

    let { response, json } = await doFetch();
    if (response.status === 401) {
      const initialError = new ApiRequestError(
        response.status,
        json.code,
        json.error || `Request failed: ${path}`
      );
      try {
        const refreshed = await this.refresh(deadlineAt);
        if (refreshed) {
          ({ response, json } = await doFetch());
        }
      } catch (refreshError) {
        throw initialError.code ? initialError : refreshError;
      }
    }

    if (!response.ok || !json.success) {
      throw new ApiRequestError(
        response.status,
        json.code,
        json.error || `Request failed: ${path}`
      );
    }
    return json.data as T;
  }
}

export const ApiClient = new ApiClientClass();
