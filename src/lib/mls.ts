/**
 * App-facing TypeScript API for the local `understage-mls` Expo module.
 *
 * Phase 1 only: this file does not replace `src/lib/crypto.ts` or the
 * existing TweetNaCl send path. Production message send/receive is unchanged.
 */
import { requireNativeModule } from 'expo-modules-core';
import { api } from './api';

export type MlsAddMemberResult = {
  commit: string;
  welcome: string;
  epoch: number;
};

export type MlsRemoveMemberResult = {
  commit: string;
  epoch: number;
};

export type MlsProcessResult = {
  kind: string;
  plaintext: string | null;
  epoch: number;
};

export type MlsSelfTestResult = {
  ok: boolean;
  detail: string;
};

type UnderstageMlsNative = {
  isAvailable(): boolean;
  ciphersuiteName(): string;
  documentsDirectory(): string;
  openSession(storagePath: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  generateCredential(sessionId: string, identity: string): Promise<void>;
  exportKeyPackage(sessionId: string): Promise<string>;
  createGroup(sessionId: string): Promise<string>;
  addMember(sessionId: string, keyPackageB64: string): Promise<MlsAddMemberResult>;
  joinFromWelcome(sessionId: string, welcomeB64: string): Promise<number>;
  processIncoming(sessionId: string, messageB64: string): Promise<MlsProcessResult>;
  encrypt(sessionId: string, plaintext: string): Promise<string>;
  decrypt(sessionId: string, ciphertextB64: string): Promise<string>;
  removeMember(sessionId: string, identity: string): Promise<MlsRemoveMemberResult>;
  epoch(sessionId: string): Promise<number>;
};

function native(): UnderstageMlsNative {
  return requireNativeModule<UnderstageMlsNative>('UnderstageMls');
}

export function mlsAvailable(): boolean {
  try {
    return native().isAvailable();
  } catch {
    return false;
  }
}

export function mlsCiphersuiteName(): string {
  return native().ciphersuiteName();
}

export function mlsDocumentsDirectory(): string {
  return native().documentsDirectory();
}

export async function mlsOpenSession(storagePath: string): Promise<string> {
  return native().openSession(storagePath);
}

export async function mlsCloseSession(sessionId: string): Promise<void> {
  await native().closeSession(sessionId);
}

export async function mlsGenerateCredential(sessionId: string, identity: string): Promise<void> {
  await native().generateCredential(sessionId, identity);
}

export async function mlsExportKeyPackage(sessionId: string): Promise<string> {
  return native().exportKeyPackage(sessionId);
}

export async function mlsCreateGroup(sessionId: string): Promise<string> {
  return native().createGroup(sessionId);
}

export async function mlsAddMember(sessionId: string, keyPackageB64: string): Promise<MlsAddMemberResult> {
  return native().addMember(sessionId, keyPackageB64);
}

export async function mlsJoinFromWelcome(sessionId: string, welcomeB64: string): Promise<number> {
  return native().joinFromWelcome(sessionId, welcomeB64);
}

export async function mlsProcessIncoming(sessionId: string, messageB64: string): Promise<MlsProcessResult> {
  return native().processIncoming(sessionId, messageB64);
}

export async function mlsEncrypt(sessionId: string, plaintext: string): Promise<string> {
  return native().encrypt(sessionId, plaintext);
}

export async function mlsDecrypt(sessionId: string, ciphertextB64: string): Promise<string> {
  return native().decrypt(sessionId, ciphertextB64);
}

export async function mlsRemoveMember(sessionId: string, identity: string): Promise<MlsRemoveMemberResult> {
  return native().removeMember(sessionId, identity);
}

export async function mlsEpoch(sessionId: string): Promise<number> {
  return native().epoch(sessionId);
}

/**
 * Dev-only two-member in-process round trip: Alice creates a group, adds Bob
 * via Welcome, they encrypt and decrypt application messages both ways.
 */
export async function runMlsSelfTest(): Promise<MlsSelfTestResult> {
  if (!__DEV__) {
    return { ok: false, detail: 'MLS self-test is only available in __DEV__ builds.' };
  }
  let alice: string | null = null;
  let bob: string | null = null;
  try {
    if (!mlsAvailable()) {
      return { ok: false, detail: 'UnderstageMls native module is not available.' };
    }
    const suite = mlsCiphersuiteName();
    if (suite !== 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519') {
      return { ok: false, detail: `unexpected ciphersuite: ${suite}` };
    }
    const root = mlsDocumentsDirectory().replace(/\/+$/, '');
    const dir = `${root}/mls-selftest/${Date.now()}`;
    alice = await mlsOpenSession(`${dir}/alice.sqlite`);
    bob = await mlsOpenSession(`${dir}/bob.sqlite`);
    await mlsGenerateCredential(alice, 'alice');
    await mlsGenerateCredential(bob, 'bob');
    const bobKp = await mlsExportKeyPackage(bob);
    await mlsCreateGroup(alice);
    const added = await mlsAddMember(alice, bobKp);
    const bobEpoch = await mlsJoinFromWelcome(bob, added.welcome);
    const aliceEpoch = await mlsEpoch(alice);
    if (bobEpoch !== added.epoch || aliceEpoch !== bobEpoch) {
      return {
        ok: false,
        detail: `epoch mismatch: alice=${aliceEpoch} bob=${bobEpoch} added=${added.epoch}`,
      };
    }
    const hello = await mlsEncrypt(alice, 'hello from alice');
    const helloPt = await mlsDecrypt(bob, hello);
    if (helloPt !== 'hello from alice') {
      return { ok: false, detail: `Bob decrypted ${JSON.stringify(helloPt)}` };
    }
    const reply = await mlsEncrypt(bob, 'hello from bob');
    const replyPt = await mlsDecrypt(alice, reply);
    if (replyPt !== 'hello from bob') {
      return { ok: false, detail: `Alice decrypted ${JSON.stringify(replyPt)}` };
    }
    return {
      ok: true,
      detail: `${suite} · epoch ${aliceEpoch} · Alice ↔ Bob application messages`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  } finally {
    if (alice) {
      await mlsCloseSession(alice).catch(() => undefined);
    }
    if (bob) {
      await mlsCloseSession(bob).catch(() => undefined);
    }
  }
}


/** Client flag (default off). Set EXPO_PUBLIC_MLS_DIRECTORY=1 to publish after keygen. */
export const MLS_DIRECTORY_ENABLED = process.env.EXPO_PUBLIC_MLS_DIRECTORY === '1';
export const MLS_KEY_PACKAGE_BATCH = 20;
export const MLS_KEY_PACKAGE_WATERMARK = 5;
export const MLS_KEY_PACKAGE_LIFETIME_MS = 3 * 28 * 24 * 60 * 60 * 1000;

export type MlsPublishResult = {
  uploaded: number;
  skipped: boolean;
  reason?: string;
};

/**
 * After TweetNaCl keygen, optionally generate an MLS credential and upload a
 * batch of KeyPackages plus one last-resort package. No-ops unless the feature
 * flag is on and the native module is present. Does not change the nacl send path.
 *
 * The current native module does not export the Ed25519 signature public key
 * (exporting it would require a UniFFI API change and a native rebuild, which
 * Phase 2 was asked not to do without reporting back first). KeyPackages are
 * still published; PUT /me/mls/credential can be called once that export exists.
 */
export async function publishMlsKeyPackagesAfterKeygen(userId: string): Promise<MlsPublishResult> {
  if (!MLS_DIRECTORY_ENABLED) {
    return { uploaded: 0, skipped: true, reason: 'disabled' };
  }
  if (!mlsAvailable()) {
    return { uploaded: 0, skipped: true, reason: 'native-unavailable' };
  }
  const root = mlsDocumentsDirectory().replace(/\/+$/, '');
  const session = await mlsOpenSession(`${root}/mls/${userId}.sqlite`);
  try {
    try {
      await mlsGenerateCredential(session, userId);
    } catch {
      // Session may already hold a credential from a previous publish.
    }
    const now = Date.now();
    const notBefore = now - 60 * 60 * 1000;
    const notAfter = notBefore + MLS_KEY_PACKAGE_LIFETIME_MS;
    const packages: { ciphertext: string; lastResort: boolean; notBefore: number; notAfter: number; credentialIdentity: string }[] = [];
    for (let i = 0; i < MLS_KEY_PACKAGE_BATCH; i++) {
      const ciphertext = await mlsExportKeyPackage(session);
      packages.push({ ciphertext, lastResort: false, notBefore, notAfter, credentialIdentity: userId });
    }
    packages.push({
      ciphertext: await mlsExportKeyPackage(session),
      lastResort: true,
      notBefore,
      notAfter,
      credentialIdentity: userId,
    });
    await api('POST', '/me/key-packages', { packages });
    return { uploaded: packages.length, skipped: false };
  } finally {
    await mlsCloseSession(session).catch(() => undefined);
  }
}
