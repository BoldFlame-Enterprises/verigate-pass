import type { ApiTrace, BackendUser } from '../src/services/ApiClient';

export const PASS_NATIVE_ADAPTER_SUBSTITUTIONS = Object.freeze([
  'sqlcipher-binding',
  'secure-store',
  'device-biometrics',
  'os-connectivity',
  'push-notifications',
]);

export interface PassProductionClient {
  login(email: string, password: string): Promise<BackendUser>;
  request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number>;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<T>;
  getLastRequestTrace(): ApiTrace | null;
}

export function createPassCompatibilityDriver(client: PassProductionClient) {
  return Object.freeze({
    nativeAdapterSubstitutions: PASS_NATIVE_ADAPTER_SUBSTITUTIONS,
    login: (email: string, password: string) => client.login(email, password),
    request: <T>(path: string, options?: Parameters<PassProductionClient['request']>[1]) =>
      client.request<T>(path, options),
    trace: () => client.getLastRequestTrace(),
  });
}
