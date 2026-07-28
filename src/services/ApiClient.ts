import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_pass_access_token';
const REFRESH_TOKEN_KEY = 'verigate_pass_refresh_token';
const TOKEN_BINDING_KEY = 'verigate_pass_token_binding';
const SESSION_KIND_KEY = 'verigate_pass_session_kind';

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

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
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

  async loadTokens(): Promise<void> {
    const [accessToken, refreshToken, tokenBinding, sessionKind] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.getItemAsync(TOKEN_BINDING_KEY),
      SecureStore.getItemAsync(SESSION_KIND_KEY),
    ]);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenBinding = tokenBinding;
    this.sessionKind = sessionKind === 'account' || sessionKind === 'device'
      ? sessionKind
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
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(TOKEN_BINDING_KEY),
      SecureStore.deleteItemAsync(SESSION_KIND_KEY),
    ]);
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      }
    } finally {
      await this.clearTokens();
    }
  }

  async login(email: string, password: string): Promise<BackendUser> {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client_kind: 'pass' }),
    });
    const json: APIResponse<{
      user: BackendUser;
      accessToken: string;
      refreshToken: string;
    }> = await response.json();
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
      body: {
        event_id: eventId,
        app: 'pass',
        installation_id: installationId,
        platform,
      },
    });
    await this.setTokens(data.accessToken, data.refreshToken, { kind: 'device' });
    return data.registration;
  }

  async getDeviceState(): Promise<unknown> {
    return this.request('/devices/state');
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    const json: APIResponse<{ accessToken: string; refreshToken: string }> = await response.json();
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
    } = {}
  ): Promise<T> {
    if (!this.accessToken) throw new Error('Not authenticated');

    const query = options.params
      ? '?' + new URLSearchParams(
        Object.entries(options.params).map(([key, value]) => [key, String(value)])
      ).toString()
      : '';
    const url = `${API_BASE_URL}${path}${query}`;
    const doFetch = () => fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let response = await doFetch();
    let json: APIResponse<T> = await response.json();
    if (response.status === 401) {
      const initialError = new ApiRequestError(
        response.status,
        json.code,
        json.error || `Request failed: ${path}`
      );
      try {
        const refreshed = await this.refresh();
        if (refreshed) {
          response = await doFetch();
          json = await response.json();
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
