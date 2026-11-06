import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/// <reference types="react-native" />

const mls = vi.hoisted(() => ({
  MLS_DIRECTORY_ENABLED: true,
  mlsAddMember: vi.fn(async () => ({ commit: 'commit', welcome: 'welcome', epoch: 1 })),
  mlsAvailable: vi.fn(() => true),
  mlsCloseSession: vi.fn(async () => undefined),
  mlsCreateGroup: vi.fn(async () => 'group'),
  mlsDecrypt: vi.fn(async () => ''),
  mlsEncrypt: vi.fn(async () => ''),
  mlsEpoch: vi.fn<(session: string) => Promise<number>>(async () => { throw new Error('no group'); }),
  mlsGenerateCredential: vi.fn(async () => undefined),
  mlsGroupStorePath: vi.fn((userId: string, id: string) => `/documents/mls/${userId}/g/${id}.sqlite`),
  mlsIdentityStorePath: vi.fn((userId: string) => `/documents/mls/${userId}.sqlite`),
  mlsJoinFromWelcome: vi.fn(async () => 0),
  mlsOpenSession: vi.fn(async (path: string) => `session:${path}`),
  mlsProcessIncoming: vi.fn(async () => ({ kind: 'commit', plaintext: null, epoch: 0 })),
  mlsRemoveMember: vi.fn(async () => ({ commit: 'removed', epoch: 1 })),
}));
const { api, refreshConversation, TestApiError } = vi.hoisted(() => ({
  api: vi.fn(), refreshConversation: vi.fn(async () => undefined),
  TestApiError: class extends Error { constructor(public status: number) { super(`HTTP ${status}`); } },
}));
const exists: string[] = ['/documents/mls/alice.sqlite.vault', '/documents/mls/bob.sqlite.vault'];
vi.mock('../../../src/lib/mls', () => mls);
vi.mock('expo-file-system', () => ({
  File: class { constructor(public uri: string) {} get exists() { return exists.includes(this.uri.startsWith('file:') ? this.uri.slice(7) : this.uri); } copySync() {} },
  Directory: class { constructor(public path: string) {} create() {} },
}));
vi.mock('../../../src/lib/api', () => ({ api, ApiError: TestApiError }));
vi.mock('../../../src/lib/engine', () => ({ refreshConversation }));
vi.mock('../../../src/lib/mls', () => mls);

import { addMlsGroupMembers, catchUpMls, closeAllMlsSessions, removeMlsGroupMember } from '../../../src/lib/mls-session';
import type { Conversation } from '../../../src/lib/types';
function conversation(myRole = 'admin'): Conversation {
  return { id: 'g1', type: 'group', title: 'Crew', myRole,
    members: [{ id: 'alice', role: 'admin', mlsReady: true }, { id: 'bob', role: 'member', mlsReady: true }, { id: 'charlie', role: 'member', mlsReady: true }],
  } as unknown as Conversation;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__DEV__', true);
  api.mockReset().mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/conversations/g1') return { conversation: conversation() };
    if (method === 'GET' && path.startsWith('/users/')) return { ciphertext: `kp-${path}` };
    if (method === 'GET' && path.startsWith('/conversations/g1/mls')) return { group: { conversationId: 'g1', groupId: 'group', epoch: null }, messages: [] };
    if (method === 'POST') return {};
    return {};
  });
});
describe('flagged MLS group membership', () => {
  it('only Welcomes newly selected members and refreshes once', async () => {
    const recv = conversation();
    mls.mlsEpoch.mockResolvedValue(0);
    await addMlsGroupMembers('g1', ['charlie'], 'alice');
    expect(api.mock.calls.filter(call => call[1].startsWith('/users/'))).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('GET', '/users/charlie/key-package');
    expect(api).not.toHaveBeenCalledWith('GET', '/users/bob/key-package');
    expect(api).toHaveBeenCalledWith('POST', '/conversations/g1/mls/commits', { epoch: 0, commit: 'commit', welcomes: [{ recipientId: 'charlie', body: 'welcome' }] });
    expect(refreshConversation).toHaveBeenCalledExactlyOnceWith('g1');
    expect(recv.myRole).toBe('admin');
  });
  it('scopes cached sessions to account and conversation', async () => {
    mls.mlsEpoch.mockResolvedValue(0);
    await catchUpMls('alice', 'g1');
    await catchUpMls('bob', 'g1');
    expect(mls.mlsOpenSession.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['/documents/mls/alice/g/g1.sqlite', '/documents/mls/bob/g/g1.sqlite']));
    await closeAllMlsSessions();
  });
  it('fails when an existing server group has no Welcome', async () => {
    api.mockImplementation(async (method: string) => method === 'GET' ? { group: { epoch: 2 }, messages: [] } : {});
    await expect(catchUpMls('bob', 'g1')).rejects.toThrow(/no Welcome|catch-up incomplete/);
    expect(mls.mlsProcessIncoming).not.toHaveBeenCalled();
  });
  it('does not claim a server epoch committed by another member is locally applied', async () => {
    api.mockImplementation(async (method: string) => method === 'GET' ? { group: { epoch: 2 }, messages: [] } : {});
    mls.mlsEpoch.mockResolvedValue(0);
    await expect(catchUpMls('alice', 'g1')).rejects.toThrow('catch-up incomplete');
  });
  it('requests the unseen Commit produced at the local epoch boundary', async () => {
    api.mockImplementation(async (method: string, path: string) => {
      if (method !== 'GET') return {};
      expect(path).toContain('after_epoch=0');
      return { group: { epoch: 2 }, messages: [{ kind: 'commit', epoch: 1, body: 'next' }] };
    });
    mls.mlsEpoch.mockResolvedValue(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    mls.mlsProcessIncoming.mockResolvedValue({ kind: 'commit', plaintext: null, epoch: 2 });
    await expect(catchUpMls('alice', 'g1')).resolves.toBe(2);
    expect(mls.mlsProcessIncoming).toHaveBeenCalledWith(expect.any(String), 'next');
  });
  it('does not apply a Commit before joining with Welcome', async () => {
    api.mockImplementation(async (method: string) => method === 'GET' ? { group: { epoch: 1 }, messages: [{ kind: 'welcome', epoch: 0, body: 'for-bob', recipientId: 'alice' }, { kind: 'commit', epoch: 0, body: 'for-creator' }] } : {});
    mls.mlsJoinFromWelcome.mockResolvedValue(1);
    let joins = 0;
    mls.mlsEpoch.mockImplementation(async () => { if (joins++ === 0) throw new Error('no group'); return 1; });
    await expect(catchUpMls('bob', 'g1')).resolves.toBe(1);
    expect(mls.mlsProcessIncoming).not.toHaveBeenCalled();
  });
  it('uses the first Welcome and never replaces this device with a later historical Welcome', async () => {
    api.mockImplementation(async (method: string) => method === 'GET' ? {
      group: { epoch: 2 },
      messages: [
        { kind: 'welcome', epoch: 0, body: 'for-alice', recipientId: 'alice' },
        { kind: 'commit', epoch: 0, body: 'already-in-welcome' },
        { kind: 'commit', epoch: 1, body: 'next' },
        { kind: 'welcome', epoch: 1, body: 'for-charlie', recipientId: 'charlie' },
      ],
    } : {});
    mls.mlsJoinFromWelcome.mockResolvedValue(1);
    mls.mlsEpoch.mockResolvedValue(2).mockRejectedValueOnce(new Error('no group'));
    mls.mlsProcessIncoming.mockResolvedValue({ kind: 'commit', plaintext: null, epoch: 2 });
    await expect(catchUpMls('alice', 'g1')).resolves.toBe(2);
    expect(mls.mlsJoinFromWelcome).toHaveBeenCalledOnce();
    expect(mls.mlsJoinFromWelcome).toHaveBeenCalledWith(expect.any(String), 'for-alice');
    expect(mls.mlsProcessIncoming).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'next');
  });
  it('does not remove a plaintext roster member if the MLS Remove cannot be posted', async () => {
    mls.mlsEpoch.mockResolvedValue(0);
    api.mockReset().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/conversations/g1') return { conversation: conversation() };
      if (method === 'GET') return { group: { epoch: 0 }, messages: [] };
      if (method === 'POST') throw new TestApiError(503);
      return {};
    });
    await expect(removeMlsGroupMember('g1', 'bob', 'alice')).rejects.toMatchObject({ status: 503 });
    expect(api).not.toHaveBeenCalledWith('DELETE', '/conversations/g1/members/bob');
    expect(refreshConversation).not.toHaveBeenCalled();
  });
  it('catches up to a competing epoch and retries the Remove without leaving an old roster', async () => {
    mls.mlsEpoch.mockResolvedValue(1);
    mls.mlsRemoveMember.mockResolvedValueOnce({ commit: 'removed-on-old-epoch', epoch: 1 })
      .mockResolvedValueOnce({ commit: 'removed-on-current-epoch', epoch: 2 });
    mls.mlsProcessIncoming.mockResolvedValueOnce({ kind: 'commit', plaintext: null, epoch: 1 }).mockResolvedValueOnce({ kind: 'commit', plaintext: null, epoch: 2 });
    mls.mlsEpoch.mockResolvedValue(1).mockResolvedValueOnce(0);
    api.mockReset().mockImplementation(async (method: string, path: string, body?: any) => {
      if (method === 'GET' && path === '/conversations/g1') return { conversation: conversation() };
      if (method === 'GET') return { group: { epoch: 1 }, messages: [{ kind: 'commit', epoch: 0, body: 'competitor' }] };
      if (method === 'POST' && body.commit === 'removed-on-old-epoch') throw new TestApiError(409);
      return {};
    });
    await removeMlsGroupMember('g1', 'bob', 'alice');
    expect(api).toHaveBeenCalledWith('POST', '/conversations/g1/mls/commits', { epoch: 1, commit: 'removed-on-current-epoch', welcomes: [] });
    expect(api).toHaveBeenCalledWith('DELETE', '/conversations/g1/members/bob');
    expect(refreshConversation).toHaveBeenCalledExactlyOnceWith('g1');
  });
  it('does not issue client-only Removes for a non-admin member', async () => {
    api.mockReset().mockImplementation(async (method: string) => {
      if (method === 'GET') return { conversation: conversation('member') };
      return {};
    });
    await expect(removeMlsGroupMember('g1', 'bob', 'alice')).rejects.toThrow('Only a group admin');
    expect(mls.mlsRemoveMember).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalledWith('DELETE', '/conversations/g1/members/bob');
  });
});

afterEach(async () => { await closeAllMlsSessions(); });
