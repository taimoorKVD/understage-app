import * as SecureStore from 'expo-secure-store';
import type { Identity } from '../../shared/e2ee';
// Tokens and the X25519 secret key live only in the iOS Keychain (via SecureStore), never in SQLite/AsyncStorage.
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export interface Session { accessToken: string; refreshToken: string; userId: string }
export const secure = {
  async getSession(): Promise<Session | null> { const v = await SecureStore.getItemAsync('session', opts); return v ? JSON.parse(v) : null; },
  setSession: (s: Session) => SecureStore.setItemAsync('session', JSON.stringify(s), opts),
  clearSession: () => SecureStore.deleteItemAsync('session', opts),
  async getIdentity(userId: string): Promise<Identity | null> { const v = await SecureStore.getItemAsync(`identity_${userId}`, opts); return v ? JSON.parse(v) : null; },
  setIdentity: (userId: string, id: Identity) => SecureStore.setItemAsync(`identity_${userId}`, JSON.stringify(id), opts),
};
