/**
 * Feature-flagged MLS conversation sessions (Phase 3).
 *
 * Uses the existing native module (one group per sqlite session) by copying the
 * identity vault into a per-conversation store. Does not replace the nacl path
 * unless the directory flag is on, the module is present, and every member is
 * MLS-ready.
 */
import { File, Directory } from 'expo-file-system';
import { api, ApiError } from './api';
import type { Conversation } from './types';
import type { PlainMessage } from './crypto';
import {
  MLS_DIRECTORY_ENABLED,
  mlsAddMember,
  mlsAvailable,
  mlsCloseSession,
  mlsCreateGroup,
  mlsDecrypt,
  mlsEncrypt,
  mlsEpoch,
  mlsGenerateCredential,
  mlsGroupStorePath,
  mlsIdentityStorePath,
  mlsJoinFromWelcome,
  mlsOpenSession,
  mlsProcessIncoming,
  mlsRemoveMember,
} from './mls';
import {
  conversationSupportsMls,
  decodeMlsApplication,
  encodeMlsApplication,
  mlsFounderId,
} from '../../shared/mls-protocol';

const groupSessions = new Map<string, string>();

function vaultPath(sqlitePath: string) {
  return `${sqlitePath}.vault`;
}

function asFile(path: string) {
  return new File(path.startsWith('file:') ? path : `file://${path}`);
}

function exists(path: string) {
  try {
    return asFile(path).exists;
  } catch {
    return false;
  }
}

function ensureDir(path: string) {
  const i = path.lastIndexOf('/');
  if (i <= 0) return;
  try {
    new Directory(path.slice(0, i)).create({ intermediates: true, idempotent: true });
  } catch {
    // openSession also creates parent directories
  }
}

function copyFile(from: string, to: string) {
  if (from === to) return;
  const src = asFile(from);
  const dest = asFile(to);
  if (!src.exists || dest.exists) return;
  ensureDir(to);
  src.copySync(dest);
}

export function conversationCanUseMls(conv: Conversation): boolean {
  return MLS_DIRECTORY_ENABLED && mlsAvailable() && conversationSupportsMls(true, conv.members);
}

async function ensureIdentity(userId: string) {
  const path = mlsIdentityStorePath(userId);
  ensureDir(path);
  const session = await mlsOpenSession(path);
  try {
    if (!exists(vaultPath(path))) {
      await mlsGenerateCredential(session, userId);
    }
  } finally {
    await mlsCloseSession(session).catch(() => undefined);
  }
}

async function openGroupSession(userId: string, conversationId: string): Promise<string> {
  const cached = groupSessions.get(conversationId);
  if (cached) return cached;
  await ensureIdentity(userId);
  const dest = mlsGroupStorePath(userId, conversationId);
  ensureDir(dest);
  copyFile(vaultPath(mlsIdentityStorePath(userId)), vaultPath(dest));
  const session = await mlsOpenSession(dest);
  groupSessions.set(conversationId, session);
  return session;
}

export async function closeAllMlsSessions() {
  const ids = [...groupSessions.values()];
  groupSessions.clear();
  await Promise.all(ids.map(id => mlsCloseSession(id).catch(() => undefined)));
}

type MlsWire = {
  kind: 'commit' | 'welcome';
  body: string;
  recipientId?: string;
};

async function fetchMls(conversationId: string, afterEpoch = -1) {
  return api<{
    group: { conversationId: string; groupId: string; epoch: number | null };
    messages: MlsWire[];
  }>('GET', `/conversations/${conversationId}/mls?after_epoch=${afterEpoch}`);
}

export async function catchUpMls(userId: string, conversationId: string): Promise<number | null> {
  if (!MLS_DIRECTORY_ENABLED || !mlsAvailable()) return null;
  const session = await openGroupSession(userId, conversationId);
  let localEpoch = -1;
  try {
    localEpoch = await mlsEpoch(session);
  } catch {
    localEpoch = -1;
  }
  const { group, messages } = await fetchMls(conversationId, localEpoch);
  for (const msg of messages) {
    if (msg.kind === 'welcome') {
      try {
        await mlsJoinFromWelcome(session, msg.body);
      } catch {
        // already joined this group
      }
    } else if (msg.kind === 'commit') {
      try {
        await mlsProcessIncoming(session, msg.body);
      } catch {
        // commit already merged or not applicable yet
      }
    }
  }
  try {
    return await mlsEpoch(session);
  } catch {
    return group.epoch;
  }
}

async function hasLocalGroup(session: string) {
  try {
    await mlsEpoch(session);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMlsGroup(conv: Conversation, userId: string): Promise<void> {
  if (!conversationCanUseMls(conv)) return;
  const session = await openGroupSession(userId, conv.id);
  await catchUpMls(userId, conv.id);
  if (await hasLocalGroup(session)) return;

  const state = await fetchMls(conv.id);
  if (state.group.epoch != null) {
    await catchUpMls(userId, conv.id);
    if (await hasLocalGroup(session)) return;
    throw new Error('Waiting to be added to the encrypted MLS group');
  }

  const founder = mlsFounderId(conv.members.map(m => m.id));
  if (userId !== founder) {
    throw new Error('Waiting for the encrypted group to be created');
  }

  await mlsCreateGroup(session);
  for (const member of conv.members.filter(m => m.id !== userId)) {
    const kp = await api<{ ciphertext: string }>('GET', `/users/${member.id}/key-package`);
    const added = await mlsAddMember(session, kp.ciphertext);
    const epoch = Math.max(added.epoch - 1, 0);
    try {
      await api('POST', `/conversations/${conv.id}/mls/commits`, {
        epoch,
        commit: added.commit,
        welcomes: [{ recipientId: member.id, body: added.welcome }],
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await catchUpMls(userId, conv.id);
        throw new Error('MLS epoch changed — retrying');
      }
      throw err;
    }
  }
}

export async function reconcileMlsMembership(conv: Conversation, userId: string): Promise<void> {
  if (!conversationCanUseMls(conv)) return;
  const session = await openGroupSession(userId, conv.id);
  if (!(await hasLocalGroup(session))) return;
  const others = conv.members.filter(m => m.id !== userId);
  for (const member of others) {
    try {
      const kp = await api<{ ciphertext: string }>('GET', `/users/${member.id}/key-package`);
      const added = await mlsAddMember(session, kp.ciphertext);
      await api('POST', `/conversations/${conv.id}/mls/commits`, {
        epoch: Math.max(added.epoch - 1, 0),
        commit: added.commit,
        welcomes: [{ recipientId: member.id, body: added.welcome }],
      });
    } catch {
      // already a member, no KeyPackage, or another commit won the epoch
    }
  }
}

export async function encryptMlsPlain(conv: Conversation, userId: string, plain: PlainMessage): Promise<{ ciphertext: string; epoch: number }> {
  await ensureMlsGroup(conv, userId);
  const session = await openGroupSession(userId, conv.id);
  const ciphertext = await mlsEncrypt(session, encodeMlsApplication(plain));
  const epoch = await mlsEpoch(session);
  return { ciphertext, epoch };
}

export async function decryptMlsCipher(userId: string, conversationId: string, ciphertext: string): Promise<PlainMessage | null> {
  try {
    await catchUpMls(userId, conversationId);
    const session = await openGroupSession(userId, conversationId);
    const plaintext = await mlsDecrypt(session, ciphertext);
    return decodeMlsApplication<PlainMessage>(plaintext);
  } catch {
    return null;
  }
}

export async function removeMlsMember(conv: Conversation, userId: string, memberId: string): Promise<void> {
  if (!conversationCanUseMls(conv)) return;
  const session = await openGroupSession(userId, conv.id);
  const removed = await mlsRemoveMember(session, memberId);
  await api('POST', `/conversations/${conv.id}/mls/commits`, {
    epoch: Math.max(removed.epoch - 1, 0),
    commit: removed.commit,
    welcomes: [],
  });
}
