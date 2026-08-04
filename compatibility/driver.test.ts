import {
  createPassCompatibilityDriver,
  PASS_NATIVE_ADAPTER_SUBSTITUTIONS,
  PassProductionClient,
} from './driver';

describe('Pass compatibility driver', () => {
  it('delegates to the production client contract and declares native boundaries', async () => {
    const request = jest.fn(async () => ({ ok: true }));
    const client: PassProductionClient = {
      login: jest.fn(async () => ({ id: 1 } as never)),
      request: request as PassProductionClient['request'],
      getLastRequestTrace: jest.fn(() => ({ correlationId: 'operation-1', requestId: 'request-1' })),
    };
    const driver = createPassCompatibilityDriver(client);

    await driver.login('pass@example.test', 'not-recorded');
    await driver.request('/events');

    expect(client.login).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/events', undefined);
    expect(driver.trace()).toEqual({ correlationId: 'operation-1', requestId: 'request-1' });
    expect(PASS_NATIVE_ADAPTER_SUBSTITUTIONS).toContain('sqlcipher-binding');
  });
});
