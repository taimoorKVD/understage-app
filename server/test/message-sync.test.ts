import { describe, it, expect } from 'vitest';
import { setup, signup, H } from './helpers';
import { encryptForRecipients } from '../../shared/e2ee';
import { mergeMessageList, nextSyncCursor, catchUpMessages } from '../../shared/message-sync';

describe('message merge + dedupe', () => {
  it('dedupes by key, clientId, and server id and keeps seq order', () => {
    type Row = { key: string; id: string | null; clientId: string; seq: number | null; createdAt: number; status?: string };
    const a: Row = { key: 'cid-1', id: null, clientId: 'cid-1', seq: null, createdAt: 10 };
    const server: Row = { key: 'm_1', id: 'm_1', clientId: 'cid-1', seq: 3, createdAt: 11 };
    const replay: Row = { key: 'm_1', id: 'm_1', clientId: 'cid-1', seq: 3, createdAt: 11, status: 'delivered' };
    const later: Row = { key: 'm_2', id: 'm_2', clientId: 'cid-2', seq: 4, createdAt: 20 };
    const otherIdSameClient: Row = { key: 'm_1b', id: 'm_1', clientId: 'cid-other', seq: 3, createdAt: 12 };

    let list = mergeMessageList<Row>([], a);
    list = mergeMessageList(list, server);
    expect(list.map(m => m.key)).toEqual(['m_1']);
    expect(list[0].id).toBe('m_1');

    list = mergeMessageList(list, later);
    list = mergeMessageList(list, replay);
    expect(list.map(m => m.id)).toEqual(['m_1', 'm_2']);
    expect((list[0] as any).status).toBe('delivered');

    list = mergeMessageList(list, otherIdSameClient);
    expect(list.filter(m => m.id === 'm_1')).toHaveLength(1);
    expect(list.find(m => m.id === 'm_1')?.key).toBe('m_1b');
  });

  it('catch-up takes only seqs after the cursor and advances it', () => {
    const rows = [
      { id: 'm1', seq: 7 },
      { id: 'm2', seq: 8 },
      { id: 'm3', seq: 10 },
    ];
    expect(catchUpMessages(rows, 8).map(m => m.id)).toEqual(['m3']);
    expect(catchUpMessages(rows, 10)).toEqual([]);
    expect(nextSyncCursor(8, rows)).toBe(10);
    expect(nextSyncCursor(12, rows)).toBe(12);
    expect(nextSyncCursor(0, [])).toBe(0);
  });
});

describe('reconnect catch-up via /sync', () => {
  it('returns only messages after the cursor and does not duplicate already-seen ids', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const b = await signup(t, 'marcus.lx');
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));

    const send = async (clientId: string, text: string) => {
      const payloads = encryptForRecipients({ v: 1, type: 'text', text, sentAt: 1 }, keys, a.id_.secretKey);
      const r = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId, payloads } });
      expect(r.statusCode).toBe(200);
      return r.json().message;
    };

    const first = await send('cid-catch-01', 'before disconnect');
    const seen = (await t.app.inject({ method: 'GET', url: `/sync?since=0`, headers: H(b) })).json();
    expect(seen.messages.map((m: any) => m.id)).toEqual([first.id]);
    expect(seen.cursor).toBe(first.seq);

    const missed = await send('cid-catch-02', 'while offline');
    const catchup = (await t.app.inject({ method: 'GET', url: `/sync?since=${seen.cursor}`, headers: H(b) })).json();
    expect(catchup.messages.map((m: any) => m.id)).toEqual([missed.id]);
    expect(catchup.cursor).toBe(missed.seq);

    const replay = (await t.app.inject({ method: 'GET', url: `/sync?since=${seen.cursor}`, headers: H(b) })).json();
    const merged = [...catchup.messages, ...replay.messages].reduce(
      (list: any[], m: any) => mergeMessageList(list, { ...m, key: m.id }),
      [],
    );
    expect(merged.map((m: any) => m.id)).toEqual([missed.id]);

    const none = (await t.app.inject({ method: 'GET', url: `/sync?since=${catchup.cursor}`, headers: H(b) })).json();
    expect(none.messages).toEqual([]);
    expect(none.cursor).toBe(catchup.cursor);
  });

  it('receipt-only updates do not advance /sync; conversation history carries the new ticks', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const b = await signup(t, 'marcus.lx');
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    const payloads = encryptForRecipients({ v: 1, type: 'text', text: 'stand by', sentAt: 1 }, keys, a.id_.secretKey);
    const msg = (await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: 'cid-ticks-01', payloads } })).json().message;

    await t.app.inject({ method: 'POST', url: '/messages/delivered', headers: H(b), payload: { messageIds: [msg.id] } });
    await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/read`, headers: H(b), payload: { seq: msg.seq } });

    const sync = (await t.app.inject({ method: 'GET', url: `/sync?since=${msg.seq}`, headers: H(a) })).json();
    expect(sync.messages).toEqual([]);
    expect(sync.cursor).toBe(msg.seq);

    const page = (await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(a) })).json().messages;
    expect(page[0].id).toBe(msg.id);
    expect(page[0].status).toBe('read');
    expect(page[0].readBy).toBe(1);
  });
});
