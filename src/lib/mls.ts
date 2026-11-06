/**
 * App-facing TypeScript API for the local `understage-mls` Expo module.
 *
 * The TypeScript MLS APIs remain feature-flagged off by default. Native
 * credentials and KeyPackages are published only when the directory is enabled.
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
  signaturePublicKey(sessionId: string): Promise<string>;
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

export async function mlsSignaturePublicKey(sessionId: string): Promise<string> {
  return native().signaturePublicKey(sessionId);
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
 * Dev-only three-member native round trip: Alice adds Bob and Charlie via
 * Welcomes, credentials persist, then Bob loses access at the removal epoch.
 */
export async function runMlsSelfTest(): Promise<MlsSelfTestResult> {
  if (!__DEV__) {
    return { ok: false, detail: 'MLS self-test is only available in __DEV__ builds.' };
  }
  let alice: string | null = null;
  let bob: string | null = null;
  let charlie: string | null = null;
  let step = 'check native availability';
  try {
    if (!mlsAvailable()) {
      return { ok: false, detail: 'UnderstageMls native module is not available.' };
    }
    step = 'read ciphersuite';
    const suite = mlsCiphersuiteName();
    if (suite !== 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519') {
      return { ok: false, detail: `unexpected ciphersuite: ${suite}` };
    }
    step = 'resolve documents directory';
    const root = mlsDocumentsDirectory().replace(/\/+$/, '');
    const dir = `${root}/mls-selftest/${Date.now()}`;
    step = 'open identity vaults';
    alice = await mlsOpenSession(`${dir}/alice.sqlite`);
    bob = await mlsOpenSession(`${dir}/bob.sqlite`);
    charlie = await mlsOpenSession(`${dir}/charlie.sqlite`);
    step = 'generate credentials';
    await mlsGenerateCredential(alice, 'alice');
    await mlsGenerateCredential(bob, 'bob');
    await mlsGenerateCredential(charlie, 'charlie');
    step = 'export signature keys';
    const aliceKey = await mlsSignaturePublicKey(alice);
    const bobKey = await mlsSignaturePublicKey(bob);
    const charlieKey = await mlsSignaturePublicKey(charlie);
    if (
      aliceKey.length !== 44 || bobKey.length !== 44 || charlieKey.length !== 44 ||
      new Set([aliceKey, bobKey, charlieKey]).size !== 3
    ) {
      return { ok: false, detail: 'signature public-key export failed' };
    }
    step = 'create group and add Bob';
    const bobKp = await mlsExportKeyPackage(bob);
    await mlsCreateGroup(alice);
    const added = await mlsAddMember(alice, bobKp);
    const bobEpoch = await mlsJoinFromWelcome(bob, added.welcome);
    const charlieAdded = await mlsAddMember(alice, await mlsExportKeyPackage(charlie));
    const bobCharlie = await mlsProcessIncoming(bob, charlieAdded.commit);
    const charlieEpoch = await mlsJoinFromWelcome(charlie, charlieAdded.welcome);
    const aliceEpoch = await mlsEpoch(alice);
    if (
      bobEpoch !== added.epoch || aliceEpoch !== charlieAdded.epoch ||
      bobCharlie.epoch !== aliceEpoch || charlieEpoch !== aliceEpoch
    ) {
      return {
        ok: false,
        detail: `epoch mismatch: alice=${aliceEpoch} bob=${bobCharlie.epoch} charlie=${charlieEpoch}`,
      };
    }
    step = 'bidirectional encrypted messaging';
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
    step = 'reload persisted identity and group';
    await mlsCloseSession(alice);
    await mlsCloseSession(bob);
    bob = null;
    await mlsCloseSession(charlie);
    charlie = null;
    step = 'open identity vaults';
    alice = await mlsOpenSession(`${dir}/alice.sqlite`);
    bob = await mlsOpenSession(`${dir}/bob.sqlite`);
    charlie = await mlsOpenSession(`${dir}/charlie.sqlite`);
    if (
      await mlsSignaturePublicKey(alice) !== aliceKey ||
      await mlsSignaturePublicKey(bob) !== bobKey ||
      await mlsSignaturePublicKey(charlie) !== charlieKey
    ) {
      return { ok: false, detail: 'native identity vault changed after reload' };
    }
    const persisted = await mlsEncrypt(alice, 'persisted identity and group');
    if (await mlsDecrypt(bob, persisted) !== 'persisted identity and group' || await mlsDecrypt(charlie, persisted) !== 'persisted identity and group') {
      return { ok: false, detail: 'reloaded native identity could not decrypt its group' };
    }
    step = 'remove Bob and verify new-epoch isolation';
    const removed = await mlsRemoveMember(alice, 'bob');
    const caughtUp = await mlsProcessIncoming(bob, removed.commit);
    const remaining = await mlsProcessIncoming(charlie, removed.commit);
    if (caughtUp.kind !== 'commit' || remaining.kind !== 'commit' || remaining.epoch !== removed.epoch) {
      return { ok: false, detail: 'removal Commit did not advance both member epochs' };
    }
    const sealed = await mlsEncrypt(alice, 'new epoch');
    if (await mlsDecrypt(charlie, sealed) !== 'new epoch') {
      return { ok: false, detail: 'remaining member could not decrypt at new epoch' };
    }
    let removedFailed = false;
    try { await mlsDecrypt(bob, sealed); } catch { removedFailed = true; }
    let removedCannotWrite = false;
    try { await mlsEncrypt(bob, 'must fail'); } catch { removedCannotWrite = true; }
    if (!removedFailed || !removedCannotWrite) {
      return { ok: false, detail: 'removed member retained group read/write access' };
    }
    return {
      ok: true,
      detail: `${suite} · epochs ${aliceEpoch}→${caughtUp.epoch} · Alice ↔ Bob · persisted vault · signature export · removal`,
    };
  } catch (err) {
    let message = 'Unknown native MLS error';
    try {
      if (typeof err === 'object' && err !== null && 'message' in err) {
        const candidate = (err as { message?: unknown }).message;
        if (typeof candidate === 'string') message = candidate;
      } else if (typeof err === 'string') {
        message = err;
      } else {
        message = JSON.stringify(err);
      }
    } catch {
      message = 'Native MLS invocation failed without a serializable error';
    }
    return { ok: false, detail: `${step}: ${message}` };
  } finally {
    if (alice) {
      await mlsCloseSession(alice).catch(() => undefined);
    }
    if (bob) {
      await mlsCloseSession(bob).catch(() => undefined);
    }
    if (charlie) {
      await mlsCloseSession(charlie).catch(() => undefined);
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
 * The Ed25519 signature public key comes from the native credential; the full
 * identity is published before KeyPackages so readiness has cryptographic proof.
 */
function fileExists(path: string): boolean {
  try {
    const { File } = require('expo-file-system') as { File: new (uri: string) => { exists: boolean } };
    return new File(path).exists;
  } catch {
    return false;
  }
}

export function mlsIdentityStorePath(userId: string): string {
  const root = mlsDocumentsDirectory().replace(/\/+$/, '');
  return `${root}/mls/${userId}.sqlite`;
}

export function mlsGroupStorePath(userId: string, conversationId: string): string {
  const root = mlsDocumentsDirectory().replace(/\/+$/, '');
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${root}/mls/${userId}/g/${safe}.sqlite`;
}

export async function publishMlsKeyPackagesAfterKeygen(userId: string): Promise<MlsPublishResult> {
  if (!MLS_DIRECTORY_ENABLED) {
    return { uploaded: 0, skipped: true, reason: 'disabled' };
  }
  if (!mlsAvailable()) {
    return { uploaded: 0, skipped: true, reason: 'native-unavailable' };
  }
  const root = mlsDocumentsDirectory().replace(/\/+$/, '');
  const sessionPath = `${root}/mls/${userId}.sqlite`;
  const session = await mlsOpenSession(sessionPath);
  try {
    // generateCredential always mints a new signer. Only call it when no vault exists
    // so a later publish cannot silently rotate the MLS identity.
    if (!fileExists(`${sessionPath}.vault`)) {
      await mlsGenerateCredential(session, userId);
    }
    const signaturePublicKey = await mlsSignaturePublicKey(session);
    await api('PUT', '/me/mls/credential', { signaturePublicKey, credentialIdentity: userId });
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
