import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import * as Device from 'expo-device';
import type { Identity } from '../../shared/e2ee';

// Tokens and the X25519 secret key prefer the iOS Keychain (SecureStore).
// On unsigned Simulator builds Keychain can fail with "required entitlement isn't present";
// we then fall back to the app sandbox document directory so local testing can proceed.
// Never use the plaintext-file fallback on a physical device, even in __DEV__.
const allowFileFallback = !Device.isDevice;
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export interface Session { accessToken: string; refreshToken: string; userId: string }

let keychainOk: boolean | null = null;
const mem = new Map<string, string>();

function fallbackFile(key: string) {
  return new File(Paths.document, `understage_secure_${key}.json`);
}

async function fbGet(key: string): Promise<string | null> {
  if (mem.has(key)) return mem.get(key)!;
  try {
    const f = fallbackFile(key);
    if (!f.exists) return null;
    const v = await f.text();
    mem.set(key, v);
    return v;
  } catch { return null; }
}

async function fbSet(key: string, value: string): Promise<void> {
  mem.set(key, value);
  const f = fallbackFile(key);
  f.create({ intermediates: true, overwrite: true });
  f.write(value);
}

async function fbDel(key: string): Promise<void> {
  mem.delete(key);
  try {
    const f = fallbackFile(key);
    if (f.exists) f.delete();
  } catch {}
}

function isKeychainEntitlementError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /entitlement|Keychain|getValueWithKeyAsync|setValueWithKeyAsync|deleteValueWithKeyAsync/i.test(msg);
}

async function getItem(key: string): Promise<string | null> {
  if (keychainOk === false) return fbGet(key);
  try {
    const v = await SecureStore.getItemAsync(key, opts);
    keychainOk = true;
    return v;
  } catch (e) {
    if (!isKeychainEntitlementError(e)) throw e;
    if (!allowFileFallback) {
      console.warn('[secure] Keychain unavailable on a physical device; refusing file fallback', {
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : typeof e,
        code: (e as { code?: unknown }).code,
        cause: String((e as { cause?: unknown }).cause ?? ''),
      });
      throw e;
    }
    console.warn('[secure] Keychain unavailable; using sandbox file fallback for Simulator sessions');
    keychainOk = false;
    return fbGet(key);
  }
}

async function setItem(key: string, value: string): Promise<void> {
  if (keychainOk === false) { await fbSet(key, value); return; }
  try {
    await SecureStore.setItemAsync(key, value, opts);
    keychainOk = true;
  } catch (e) {
    if (!isKeychainEntitlementError(e)) throw e;
    if (!allowFileFallback) {
      console.warn('[secure] Keychain unavailable on a physical device; refusing file fallback', {
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : typeof e,
        code: (e as { code?: unknown }).code,
        cause: String((e as { cause?: unknown }).cause ?? ''),
      });
      throw e;
    }
    console.warn('[secure] Keychain unavailable; using sandbox file fallback for Simulator sessions');
    keychainOk = false;
    await fbSet(key, value);
  }
}

async function delItem(key: string): Promise<void> {
  if (keychainOk === false) { await fbDel(key); return; }
  try {
    await SecureStore.deleteItemAsync(key, opts);
    keychainOk = true;
  } catch (e) {
    if (!isKeychainEntitlementError(e)) throw e;
    if (!allowFileFallback) {
      console.warn('[secure] Keychain unavailable on a physical device; refusing file fallback');
      throw e;
    }
    keychainOk = false;
    await fbDel(key);
  }
}

export const secure = {
  async getSession(): Promise<Session | null> {
    const v = await getItem('session');
    return v ? JSON.parse(v) : null;
  },
  setSession: (s: Session) => setItem('session', JSON.stringify(s)),
  clearSession: () => delItem('session'),
  async getIdentity(userId: string): Promise<Identity | null> {
    const v = await getItem(`identity_${userId}`);
    return v ? JSON.parse(v) : null;
  },
  setIdentity: (userId: string, id: Identity) => setItem(`identity_${userId}`, JSON.stringify(id)),
};
