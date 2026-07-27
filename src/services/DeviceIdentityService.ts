import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const INSTALLATION_ID_KEY = 'verigate_pass_installation_id';

class DeviceIdentityServiceClass {
  private installationId: string | null = null;

  async getOrCreate(): Promise<string> {
    if (this.installationId) return this.installationId;
    const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
    if (stored) {
      this.installationId = stored;
      return stored;
    }
    this.installationId = `pass-${Crypto.randomUUID()}`;
    await SecureStore.setItemAsync(INSTALLATION_ID_KEY, this.installationId);
    return this.installationId;
  }
}

export const DeviceIdentityService = new DeviceIdentityServiceClass();
