import { describe, it, expect } from 'vitest';
import { setup, signup, H, grantPlan } from './helpers';
import { buildApp } from '../src/app';
import { ConsoleOtpSender, MemoryPushSender } from '../src/providers';
import { encryptForRecipients, decryptPayload, safetyNumber, encryptBlob, decryptBlob, base64 } from '../../shared/e2ee';
import { isOnShift } from '../src/util';

describe('auth', () => {
  it('OTP request/verify, wrong code, refresh rotation, logout', async () => {
    const t = setup();
    const bad = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { kind: 'phone', destination: '123' } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toBe('INVALID_PHONE');
    const dest = '+447700900111';
    const r = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { kind: 'phone', destination: dest } });
    expect(r.statusCode).toBe(200);
    const code = r.json().devCode as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(t.otp.last?.code).toBe(code);
    const wrong = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination: dest, code: code === '000000' ? '111111' : '000000' } });
    expect(wrong.json().error).toBe('CODE_INCORRECT');
    const ok = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination: dest, code } });
    expect(ok.statusCode).toBe(200);
    const s = ok.json();
    expect(s.isNew).toBe(true);
    // code is single-use
    const reuse = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination: dest, code } });
    expect(reuse.statusCode).toBe(400);
    // phone never stored/returned
    expect(JSON.stringify(s.user)).not.toContain('7700900111');
    const row = t.ctx.db.prepare('SELECT * FROM users').get() as any;
    expect(JSON.stringify(row)).not.toContain('7700900111');
    const me = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${s.accessToken}` } });
    expect(me.statusCode).toBe(200);
    const ref = await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(ref.statusCode).toBe(200);
    // old refresh token reuse => revoked session
    const reused = await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(reused.statusCode).toBe(401);
    const after = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${ref.json().accessToken}` } });
    expect(after.json().error).toBe('SESSION_REVOKED');
    // second login (account recovery on new device) returns same user, isNew false
    const r3 = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { kind: 'phone', destination: dest } });
    const again = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination: dest, code: r3.json().devCode } });
    expect(again.json().isNew).toBe(false);
    expect(again.json().user.id).toBe(s.user.id);
    const lo = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${again.json().accessToken}` }, payload: { refreshToken: again.json().refreshToken } });
    expect(lo.statusCode).toBe(200);
    const dead = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${again.json().accessToken}` } });
    expect(dead.statusCode).toBe(401);
  });

  it('username uniqueness + validation', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const b = await signup(t, 'marcus.lx');
    const chk = await t.app.inject({ method: 'GET', url: '/users/check-username?username=sophie.sm', headers: H(b) });
    expect(chk.json().available).toBe(false);
    const free = await t.app.inject({ method: 'GET', url: '/users/check-username?username=priya.dsm', headers: H(b) });
    expect(free.json().available).toBe(true);
    const taken = await t.app.inject({ method: 'PATCH', url: '/me', headers: H(b), payload: { username: 'Sophie.SM' } });
    expect(taken.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'PATCH', url: '/me', headers: H(a), payload: { username: 'x' } });
    expect(bad.statusCode).toBe(400);
    const search = await t.app.inject({ method: 'GET', url: '/users/search?q=@mar', headers: H(a) });
    expect(search.json().results.map((r: any) => r.username)).toEqual(['marcus.lx']);
  });
});

describe('E2EE messaging', () => {
  it('server stores only ciphertext; both sides decrypt; receipts flow sent→delivered→read', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const b = await signup(t, 'marcus.lx');
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    expect(keys.every((k: any) => k.publicKey)).toBe(true);
    const secret = 'Can we move cue 47 to page 62?';
    const payloads = encryptForRecipients({ v: 1, type: 'text', text: secret, sentAt: 1 }, keys, a.id_.secretKey);
    // missing recipient rejected
    const partial = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: 'cid-00000001', payloads: payloads.slice(0, 1) } });
    expect(partial.json().error).toBe('MISSING_RECIPIENTS');
    const sent = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: 'cid-00000001', payloads } });
    expect(sent.statusCode).toBe(200);
    const msg = sent.json().message;
    expect(msg.status).toBe('sent');
    // idempotent retry (outbox resend after timeout)
    const dup = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: 'cid-00000001', payloads } });
    expect(dup.json().duplicate).toBe(true); expect(dup.json().message.id).toBe(msg.id);
    expect((t.ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as any).n).toBe(1);
    // database never contains plaintext
    const dump = JSON.stringify(t.ctx.db.prepare('SELECT * FROM message_payloads').all());
    expect(dump).not.toContain('cue 47');
    // recipient fetch + decrypt
    const list = (await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(b) })).json().messages;
    const plain = decryptPayload(list[0].nonce, list[0].ciphertext, a.id_.publicKey, b.id_.secretKey);
    expect(plain).toMatchObject({ type: 'text', text: secret });
    // a third party key cannot decrypt
    const c = await signup(t, 'eve.x');
    expect(decryptPayload(list[0].nonce, list[0].ciphertext, a.id_.publicKey, c.id_.secretKey)).toBeNull();
    // non-member cannot read
    expect((await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(c) })).statusCode).toBe(404);
    // sender can decrypt own copy (multi-device history / reinstall with same key)
    const own = (await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(a) })).json().messages[0];
    expect(decryptPayload(own.nonce, own.ciphertext, a.id_.publicKey, a.id_.secretKey)).toMatchObject({ text: secret });
    // receipts
    await t.app.inject({ method: 'POST', url: '/messages/delivered', headers: H(b), payload: { messageIds: [msg.id] } });
    let st = (await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(a) })).json().messages[0];
    expect(st.status).toBe('delivered');
    const convB = (await t.app.inject({ method: 'GET', url: '/conversations', headers: H(b) })).json().conversations[0];
    expect(convB.unread).toBe(1);
    await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/read`, headers: H(b), payload: { seq: msg.seq } });
    st = (await t.app.inject({ method: 'GET', url: `/conversations/${conv.id}/messages`, headers: H(a) })).json().messages[0];
    expect(st.status).toBe('read');
    expect(t.events.some(e => e.user === a.id && e.event === 'message:status' && e.data.status === 'read')).toBe(true);
    // sync cursor
    const sync = (await t.app.inject({ method: 'GET', url: '/sync?since=0', headers: H(b) })).json();
    expect(sync.messages).toHaveLength(1); expect(sync.cursor).toBe(msg.seq);
    // push contains no plaintext
    expect(JSON.stringify(t.push.sent)).not.toContain('cue 47');
  });

  it('group fan-out encryption, membership roles, admin-only management', async () => {
    const t = setup();
    const [a, b, c, d] = [await signup(t, 'sophie.sm'), await signup(t, 'marcus.lx'), await signup(t, 'priya.dsm'), await signup(t, 'emma.wardrobe')];
    const g = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'group', title: 'LX & Sound', memberIds: [b.id, c.id] } })).json().conversation;
    expect(g.memberCount).toBe(3); expect(g.myRole).toBe('admin');
    expect((await t.app.inject({ method: 'POST', url: `/conversations/${g.id}/members`, headers: H(b), payload: { userIds: [d.id] } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/conversations/${g.id}/members`, headers: H(a), payload: { userIds: [d.id] } })).statusCode).toBe(200);
    const conv = (await t.app.inject({ method: 'GET', url: `/conversations/${g.id}`, headers: H(b) })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    const payloads = encryptForRecipients({ v: 1, type: 'text', text: 'Cue 47 moved to page 62', sentAt: 1 }, keys, b.id_.secretKey);
    const r = await t.app.inject({ method: 'POST', url: `/conversations/${g.id}/messages`, headers: H(b), payload: { clientId: 'grp-0000001', payloads } });
    expect(r.statusCode).toBe(200);
    for (const u of [a, c, d]) {
      const m = (await t.app.inject({ method: 'GET', url: `/conversations/${g.id}/messages`, headers: H(u) })).json().messages[0];
      expect(decryptPayload(m.nonce, m.ciphertext, b.id_.publicKey, u.id_.secretKey)).toMatchObject({ text: 'Cue 47 moved to page 62' });
    }
    for (const u of [a, c, d]) await t.app.inject({ method: 'POST', url: `/conversations/${g.id}/read`, headers: H(u), payload: { seq: r.json().message.seq } });
    const mine = (await t.app.inject({ method: 'GET', url: `/conversations/${g.id}/messages`, headers: H(b) })).json().messages[0];
    expect(mine.readBy).toBe(3); expect(mine.status).toBe('read');
    expect(mine.readByUserIds.sort()).toEqual([a.id, c.id, d.id].sort());
    await t.app.inject({ method: 'PATCH', url: `/conversations/${g.id}/members/${b.id}`, headers: H(a), payload: { role: 'admin' } });
    expect((await t.app.inject({ method: 'PATCH', url: `/conversations/${g.id}`, headers: H(b), payload: { title: 'LX, Sound & Video' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: `/conversations/${g.id}/members/${d.id}`, headers: H(b) })).statusCode).toBe(200);
  });

  it('attachments are encrypted blobs; safety numbers match on both sides', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm'); const b = await signup(t, 'marcus.lx');
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const file = new TextEncoder().encode('%PDF-1.4 Hamlet LX cues v7');
    const enc = encryptBlob(file);
    const up = (await t.app.inject({ method: 'POST', url: '/attachments', headers: H(a), payload: { conversationId: conv.id, data: enc.ciphertext } })).json();
    const down = (await t.app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: H(b) })).json();
    expect(new TextDecoder().decode(decryptBlob(down.data, enc.key, enc.nonce)!)).toContain('Hamlet LX');
    expect(Buffer.from(base64.decode(down.data)).toString()).not.toContain('Hamlet');
    const s1 = safetyNumber({ id: a.id, publicKey: a.id_.publicKey }, { id: b.id, publicKey: b.id_.publicKey });
    const s2 = safetyNumber({ id: b.id, publicKey: b.id_.publicKey }, { id: a.id, publicKey: a.id_.publicKey });
    expect(s1).toEqual(s2); expect(s1).toHaveLength(12); expect(s1.every(x => /^\d{5}$/.test(x))).toBe(true);
    await t.app.inject({ method: 'POST', url: '/contacts', headers: H(a), payload: { userId: b.id } });
    expect((await t.app.inject({ method: 'POST', url: `/contacts/${b.id}/verify`, headers: H(a), payload: {} })).json().verified).toBe(true);
    // key change resets verification
    await t.app.inject({ method: 'PUT', url: '/me/keys', headers: H(b), payload: { identityKey: (await import('../../shared/e2ee')).generateIdentity().publicKey } });
    expect((await t.app.inject({ method: 'GET', url: `/users/${b.id}`, headers: H(a) })).json().verified).toBe(false);
  });

  it('blocking prevents messaging and calls', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm'); const b = await signup(t, 'stagedoor.vip');
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(b), payload: { kind: 'direct', userId: a.id } })).json().conversation;
    const rep = await t.app.inject({ method: 'POST', url: '/reports', headers: H(a), payload: { reportedId: b.id, reason: 'harassment', evidence: [{ text: 'hey gorgeous', at: 1 }], alsoBlock: true } });
    expect(rep.json().number).toMatch(/^R-\d+$/);
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    const res = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(b), payload: { clientId: 'blocked-0001', payloads: encryptForRecipients({ v: 1, type: 'text', text: 'hi', sentAt: 1 }, keys, b.id_.secretKey) } });
    expect(res.statusCode).toBe(403);
    expect(() => t.calls.start('call-1', b.id, a.id)).toThrow();
  });
});

describe('QR invites', () => {
  it('valid, tampered, expired, self, and workspace invites', async () => {
    let clock = Date.now();
    const t = setup(() => clock);
    const a = await signup(t, 'priya.dsm'); const b = await signup(t, 'sophie.sm');
    grantPlan(t, a, 'company');
    const inv = (await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { ttlSec: 600 } })).json();
    expect(inv.url).toMatch(/^understage:\/\/invite\/us1\./);
    const res = (await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: inv.url } })).json();
    expect(res.user.username).toBe('priya.dsm'); expect(res.self).toBe(false);
    expect((await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(a), payload: { token: inv.token } })).json().self).toBe(true);
    const tampered = inv.token.slice(0, -3) + (inv.token.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: tampered } })).json().error).toBe('INVITE_INVALID');
    expect((await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: 'https://evil.example' } })).json().error).toBe('INVITE_INVALID');
    const acc = await t.app.inject({ method: 'POST', url: '/invites/accept', headers: H(b), payload: { token: inv.token } });
    expect(acc.json().contact.username).toBe('priya.dsm');
    expect(acc.json().alreadyContact).toBe(false);
    const again = await t.app.inject({ method: 'POST', url: '/invites/accept', headers: H(b), payload: { token: inv.token } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ kind: 'contact', alreadyContact: true });
    expect(again.json().contact.username).toBe('priya.dsm');
    const pair = (t.ctx.db.prepare('SELECT COUNT(*) n FROM contacts WHERE (owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)').get(a.id, b.id, b.id, a.id) as { n: number }).n;
    expect(pair).toBe(2);
    const contacts = (await t.app.inject({ method: 'GET', url: '/contacts', headers: H(a) })).json().contacts;
    expect(contacts.map((c: any) => c.username)).toContain('sophie.sm');
    expect(contacts.filter((c: any) => c.username === 'sophie.sm')).toHaveLength(1);
    clock += 601_000;
    const exp = await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: inv.token } });
    expect(exp.statusCode).toBe(410); expect(exp.json().error).toBe('INVITE_EXPIRED');
    // workspace invite
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027', departments: ['Lighting'] } })).json().workspace;
    const wi = (await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'workspace', workspaceId: ws.id } })).json();
    expect((await t.app.inject({ method: 'POST', url: '/invites', headers: H(b), payload: { kind: 'workspace', workspaceId: ws.id } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/invites/accept', headers: H(b), payload: { token: wi.token } })).json().workspaceId).toBe(ws.id);
    expect((await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}`, headers: H(b) })).json().workspace.memberCount).toBe(2);
  });
});

describe('workspaces, announcements & acknowledgements', () => {
  it('200-person workspace, ack tracking, remind w/ quiet hours, wrap → read-only', async () => {
    const t = setup();
    const admin = await signup(t, 'sophie.sm');
    grantPlan(t, admin, 'company');
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(admin), payload: { name: 'Hamlet UK Tour 2027', venue: 'Lyceum, Edinburgh', departments: ['Stage Management', 'Lighting'] } })).json().workspace;
    const crew = [];
    for (let i = 0; i < 199; i++) {
      // half the company is off shift right now (quiet hours on, zero-length working day)
      const u = await signup(t, `crew${String(i).padStart(3, '0')}`, i % 2 ? { quietHours: true, workDays: [] } : {});
      t.joinWorkspace(ws.id, u.id, 'member', i < 20 ? ws.departments[1].id : ws.departments[0].id);
      crew.push(u);
    }
    for (let i = 0; i < 199; i++) await t.app.inject({ method: 'POST', url: '/push/tokens', headers: H(crew[i]), payload: { token: `ExponentPushToken[crew${i}xx]`, platform: 'ios' } });
    const w = (await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}`, headers: H(admin) })).json().workspace;
    expect(w.memberCount).toBe(200);
    expect(w.departments.find((d: any) => d.name === 'Lighting').count).toBe(20);
    const members = (await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}/members?limit=500`, headers: H(admin) })).json();
    expect(members.total).toBe(200); expect(members.members[0].wsRole).toBe('owner');
    // members can't post announcements
    expect((await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: H(crew[0]), payload: { title: 'x', body: 'y' } })).statusCode).toBe(403);
    t.push.sent = [];
    const post = (await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: H(admin), payload: { title: 'Fire drill before tonight’s show', body: 'Full company on stage at 18:15.', requireAck: true, respectQuietHours: true } })).json();
    expect(post.recipients).toBe(199);
    expect(post.held).toBe(99); // odd-indexed crew are off shift
    expect(t.push.sent).toHaveLength(100);
    // department-targeted
    const dep = (await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: H(admin), payload: { title: 'LX focus call', body: 'Lighting only', departmentIds: [ws.departments[1].id] } })).json();
    expect(dep.recipients).toBe(20);
    const annId = post.announcement.id;
    for (let i = 0; i < 141; i++) await t.app.inject({ method: 'POST', url: `/announcements/${annId}/ack`, headers: H(crew[i]) });
    await t.app.inject({ method: 'POST', url: `/announcements/${annId}/seen`, headers: H(crew[150]) });
    const acks = (await t.app.inject({ method: 'GET', url: `/announcements/${annId}/acks`, headers: H(admin) })).json();
    expect(acks.announcement.acked).toBe(141); expect(acks.announcement.total).toBe(199);
    expect(acks.pending).toHaveLength(58); expect(acks.acknowledged).toHaveLength(141);
    expect(acks.announcement.seenNotAcked).toBe(1);
    expect((await t.app.inject({ method: 'GET', url: `/announcements/${annId}/acks`, headers: H(crew[0]) })).statusCode).toBe(403);
    const crewView = (await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}/announcements`, headers: H(crew[0]) })).json().announcements;
    expect(crewView.find((a: any) => a.id === annId).myAckAt).toBeTruthy();
    expect(crewView.some((a: any) => a.title === 'LX focus call')).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}/announcements`, headers: H(crew[100]) })).json().announcements.some((a: any) => a.title === 'LX focus call')).toBe(false);
    const rem = (await t.app.inject({ method: 'POST', url: `/announcements/${annId}/remind`, headers: H(admin) })).json();
    expect(rem.reminded).toBe(58); expect(rem.held + rem.deliveredNow).toBe(58); expect(rem.held).toBeGreaterThan(0);
    // held summary for an off-shift member
    const held = (await t.app.inject({ method: 'GET', url: '/me/held', headers: H(crew[1]) })).json();
    expect(held.onShift).toBe(false); expect(held.count).toBeGreaterThan(0);
    // wrap
    expect((await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/wrap`, headers: H(crew[0]) })).statusCode).toBe(403);
    const wrapped = (await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/wrap`, headers: H(admin) })).json().workspace;
    expect(wrapped.wrappedAt).toBeTruthy(); expect(wrapped.deleteAfter - wrapped.wrappedAt).toBe(30 * 86400_000);
    expect((await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: H(admin), payload: { title: 'x', body: 'y' } })).json().error).toBe('WORKSPACE_WRAPPED');
    expect((await t.app.inject({ method: 'POST', url: `/announcements/${annId}/ack`, headers: H(crew[180]) })).json().error).toBe('WORKSPACE_WRAPPED');
    const convs = (await t.app.inject({ method: 'GET', url: '/conversations', headers: H(admin) })).json().conversations;
    const wsChat = convs.find((c: any) => c.kind === 'workspace');
    expect(wsChat.readonly).toBe(true);
    expect(wsChat.e2eeError).toBe('GROUP_TOO_LARGE_FOR_E2EE');
    expect(wsChat.members.length).toBe(wsChat.memberCount);
    expect(wsChat.memberCount).toBe(200);
    const admin2 = (await t.app.inject({ method: 'GET', url: '/admin/workspaces', headers: H(admin) }));
    expect(admin2.statusCode).toBe(403);
  }, 60_000);
});

describe('quiet hours', () => {
  it('isOnShift handles day + overnight shifts and time zones', () => {
    const base = { quiet_hours: 1, work_days: '[0,1,2,3,4,5,6]', shift_start: '12:00', shift_end: '23:30' };
    const t = Date.UTC(2027, 2, 10, 14, 52); // 14:52 London (GMT)
    expect(isOnShift({ ...base, timezone: 'Europe/London' }, t)).toBe(true);
    expect(isOnShift({ ...base, timezone: 'America/New_York' }, t)).toBe(false); // 09:52 NY
    expect(isOnShift({ ...base, timezone: 'Asia/Tokyo' }, t)).toBe(false); // 23:52 Tokyo
    expect(isOnShift({ ...base, timezone: 'Asia/Tokyo', shift_start: '18:00', shift_end: '02:00' }, t)).toBe(true);
    expect(isOnShift({ ...base, quiet_hours: 0, timezone: 'America/New_York' }, t)).toBe(true);
  });

  it('held notifications are released with a single summary push when the shift starts', async () => {
    let clock = Date.UTC(2027, 2, 10, 4, 0); // 04:00 London — off shift
    const t = setup(() => clock);
    const a = await signup(t, 'daniel.pm'); const b = await signup(t, 'sophie.sm', { quietHours: true, workDays: [0, 1, 2, 3, 4, 5, 6], shiftStart: '12:00', shiftEnd: '23:30', timezone: 'Europe/London' });
    await t.app.inject({ method: 'POST', url: '/push/tokens', headers: H(b), payload: { token: 'ExponentPushToken[sophie]', platform: 'ios' } });
    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    for (let i = 0; i < 3; i++) await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: `held-msg-${i}xx`, payloads: encryptForRecipients({ v: 1, type: 'text', text: 'late note', sentAt: 1 }, keys, a.id_.secretKey) } });
    expect(t.push.sent).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: '/me/held', headers: H(b) })).json().count).toBe(3);
    expect(await t.jobs.releaseHeld()).toBe(0);
    clock = Date.UTC(2027, 2, 10, 12, 1);
    expect(await t.jobs.releaseHeld()).toBe(3);
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0].body).toContain('3 updates');
  });
});

describe('admin, subscriptions, support', () => {
  it('reports, suspensions (7d/30d/permanent), tickets, workspaces', async () => {
    const t = setup();
    const admin = await signup(t, 'ops.admin'); t.ctx.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(admin.id);
    const a = await signup(t, 'sophie.sm'); const bad = await signup(t, 'stagedoor.vip');
    await t.app.inject({ method: 'POST', url: '/reports', headers: H(a), payload: { reportedId: bad.id, reason: 'harassment', alsoBlock: true } });
    const reps = (await t.app.inject({ method: 'GET', url: '/admin/reports', headers: H(admin) })).json().reports;
    expect(reps[0].reported).toBe('stagedoor.vip');
    expect((await t.app.inject({ method: 'GET', url: '/admin/reports', headers: H(a) })).statusCode).toBe(403);
    await t.app.inject({ method: 'PATCH', url: `/admin/reports/${reps[0].id}`, headers: H(admin), payload: { status: 'actioned' } });
    const s = (await t.app.inject({ method: 'POST', url: '/admin/suspensions', headers: H(admin), payload: { userId: bad.id, duration: '7d', reason: 'Harassment' } })).json();
    expect(s.until).toBeGreaterThan(Date.now());
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: H(bad) })).statusCode).toBe(401); // sessions revoked
    const sus = (await t.app.inject({ method: 'GET', url: '/admin/suspensions', headers: H(admin) })).json().suspensions;
    expect(sus).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/admin/suspensions/${s.id}`, headers: H(admin) })).statusCode).toBe(200);
    const tk = (await t.app.inject({ method: 'POST', url: '/support/tickets', headers: H(a), payload: { subject: 'Can’t add Priya', body: 'QR says expired' } })).json();
    await t.app.inject({ method: 'POST', url: `/admin/tickets/${tk.id}/messages`, headers: H(admin), payload: { body: 'Ask her to refresh her code' } });
    const thread = (await t.app.inject({ method: 'GET', url: `/admin/tickets/${tk.id}`, headers: H(admin) })).json();
    expect(thread.messages.map((m: any) => m.author)).toEqual(['user', 'support']);
    const mine = (await t.app.inject({ method: 'GET', url: `/support/tickets/${tk.id}`, headers: H(a) })).json();
    expect(mine.messages.map((m: any) => m.author)).toEqual(['user', 'support']);
    expect((await t.app.inject({ method: 'GET', url: `/support/tickets/${tk.id}`, headers: H(bad) })).statusCode).not.toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/admin/workspaces', headers: H(admin) })).json()).toHaveProperty('wrapped');
    const audit = (await t.app.inject({ method: 'GET', url: '/admin/audit', headers: H(admin) })).json();
    expect(audit.entries.some((e: any) => e.action === 'admin.report_status')).toBe(true);
    expect(audit.entries.some((e: any) => e.action === 'admin.suspend')).toBe(true);
    expect(audit.entries.some((e: any) => e.action === 'admin.unsuspend')).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/admin/audit', headers: H(a) })).statusCode).toBe(403);
  });

  it('subscriptions: plans listed; receipt validation refuses without IAP config', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const plans = (await t.app.inject({ method: 'GET', url: '/subscriptions/plans' })).json();
    expect(plans.plans.map((p: any) => p.priceGBP)).toEqual([0, 49, 149]); expect(plans.trialDays).toBe(14);
    const v = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(a), payload: { planId: 'company', transactionId: 'x' } });
    expect(v.statusCode).toBe(501);
  });

  it('serves the web admin UI without auth and keeps admin APIs protected', async () => {
    const t = setup();
    const html = await t.app.inject({ method: 'GET', url: '/admin' });
    expect(html.statusCode).toBe(200);
    expect(String(html.headers['content-type'])).toMatch(/text\/html/);
    expect(html.body).toContain('Understage Admin');
    expect((await t.app.inject({ method: 'GET', url: '/admin/' })).statusCode).toBe(200);
    const js = await t.app.inject({ method: 'GET', url: '/admin/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toContain('Everything else stays end-to-end encrypted. Admins only see what the reporter chose to share.');
    expect(js.body).toContain('Send & close');
    expect((await t.app.inject({ method: 'GET', url: '/admin/reports' })).statusCode).toBe(401);
  });

  it('workspace stats include owner and member totals; x-admin-token authenticates', async () => {
    const t = setup();
    const admin = await signup(t, 'ops.admin'); t.ctx.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(admin.id);
    const a = await signup(t, 'sophie.sm');
    grantPlan(t, a, 'company');
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027' } })).json().workspace;
    const body = (await t.app.inject({ method: 'GET', url: '/admin/workspaces', headers: H(admin) })).json();
    expect(body.stats.active).toBeGreaterThanOrEqual(1);
    expect(body.stats.members).toBeGreaterThanOrEqual(1);
    expect(body.stats).toHaveProperty('wrapped');
    expect(body.active.find((w: any) => w.id === ws.id).owner).toBe('sophie.sm');

    const built = buildApp({ push: new MemoryPushSender(), otp: new ConsoleOtpSender(), cfg: { adminToken: 'test-admin-token' }, emit: { toUser() {}, isOnline: () => false } });
    try {
      expect((await built.app.inject({ method: 'GET', url: '/admin/reports' })).statusCode).toBe(401);
      const ok = await built.app.inject({ method: 'GET', url: '/admin/reports', headers: { 'x-admin-token': 'test-admin-token' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().reports).toEqual([]);
    } finally {
      await built.app.close();
    }
  });
});


function seedUsers(t: ReturnType<typeof setup>, n: number, prefix: string) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `usr_${prefix}${i}`;
    t.ctx.db.prepare('INSERT INTO users (id, identifier_hash, identifier_kind, display_name, username, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, `h_${prefix}${i}`, 'phone', `${prefix} ${i}`, `${prefix}${i}`, Date.now());
    ids.push(id);
  }
  return ids;
}

describe('plan enforcement, e2ee caps, visibility, invites, rate limits & search', () => {
  it('free cannot create a workspace; Production clamps to 50 seats; Company up to 200', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const free = await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027' } });
    expect(free.statusCode).toBe(403); expect(free.json().error).toBe('PLAN_REQUIRED');

    grantPlan(t, a, 'production');
    const prod = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027', seatLimit: 200 } })).json().workspace;
    expect(prod.seatLimit).toBe(50); expect(prod.plan).toBe('production');

    grantPlan(t, a, 'company');
    const company = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Company House' } })).json().workspace;
    expect(company.seatLimit).toBe(200); expect(company.plan).toBe('company');

    const clamped = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Eighty Seats', seatLimit: 80 } })).json().workspace;
    expect(clamped.seatLimit).toBe(80);

    grantPlan(t, a, 'company', Date.now() - 1000);
    const expired = await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Expired Trial Co' } });
    expect(expired.statusCode).toBe(403); expect(expired.json().error).toBe('PLAN_REQUIRED');
  });

  it('encrypted groups reject more than 50 members on create and add-members', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm');
    const extras = seedUsers(t, 51, 'g');
    const tooBig = await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'group', title: 'Too big', memberIds: extras } });
    expect(tooBig.statusCode).toBe(409); expect(tooBig.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');

    const ok = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'group', title: 'Almost full', memberIds: extras.slice(0, 48) } })).json().conversation;
    expect(ok.memberCount).toBe(49);
    const overflow = await t.app.inject({ method: 'POST', url: `/conversations/${ok.id}/members`, headers: H(a), payload: { userIds: extras.slice(48, 51) } });
    expect(overflow.statusCode).toBe(409); expect(overflow.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');
    const oneMore = await t.app.inject({ method: 'POST', url: `/conversations/${ok.id}/members`, headers: H(a), payload: { userIds: [extras[48]] } });
    expect(oneMore.statusCode).toBe(200);
    expect(oneMore.json().conversation.memberCount).toBe(50);
    const fiftyFirst = await t.app.inject({ method: 'POST', url: `/conversations/${ok.id}/members`, headers: H(a), payload: { userIds: [extras[49]] } });
    expect(fiftyFirst.statusCode).toBe(409); expect(fiftyFirst.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');
  });

  it('workspace chats over 50 members return GROUP_TOO_LARGE_FOR_E2EE without truncating the member list', async () => {
    const t = setup();
    const admin = await signup(t, 'sophie.sm');
    grantPlan(t, admin, 'company');
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(admin), payload: { name: 'Hamlet UK Tour 2027' } })).json().workspace;
    for (const id of seedUsers(t, 54, 'w')) t.joinWorkspace(ws.id, id, 'member', null);
    const conv = (await t.app.inject({ method: 'GET', url: `/conversations/${ws.conversationId}`, headers: H(admin) })).json().conversation;
    expect(conv.e2eeError).toBe('GROUP_TOO_LARGE_FOR_E2EE');
    expect(conv.members.length).toBe(conv.memberCount);
    expect(conv.memberCount).toBe(55);
    const msg = await t.app.inject({ method: 'POST', url: `/conversations/${ws.conversationId}/messages`, headers: H(admin), payload: { clientId: 'big-ws-0001', payloads: [{ recipientId: admin.id, nonce: 'n', ciphertext: 'c' }] } });
    expect(msg.statusCode).toBe(409); expect(msg.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');
  });

  it('GET /users/:id is limited to contacts, shared chats/workspaces, or a valid invite', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm'); const b = await signup(t, 'marcus.lx'); const c = await signup(t, 'eve.stranger');
    expect((await t.app.inject({ method: 'GET', url: `/users/${c.id}`, headers: H(a) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/users/${c.id}`, headers: H(a) })).json().error).toBe('USER_NOT_FOUND');
    await t.app.inject({ method: 'POST', url: '/contacts', headers: H(a), payload: { userId: b.id } });
    expect((await t.app.inject({ method: 'GET', url: `/users/${b.id}`, headers: H(a) })).statusCode).toBe(200);
    const inv = (await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'contact' } })).json();
    expect((await t.app.inject({ method: 'GET', url: `/users/${a.id}?inviteToken=${encodeURIComponent(inv.token)}`, headers: H(c) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/users/${a.id}?inviteToken=not-a-token`, headers: H(c) })).statusCode).toBe(404);
  });

  it('regenerating a contact invite revokes the previous one; workspace accept is idempotent', async () => {
    const t = setup();
    const a = await signup(t, 'priya.dsm'); const b = await signup(t, 'sophie.sm');
    grantPlan(t, a, 'company');
    const first = (await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'contact' } })).json();
    const next = (await t.app.inject({ method: 'POST', url: '/invites/regenerate', headers: H(a), payload: { kind: 'contact' } })).json();
    expect(next.token).not.toBe(first.token);
    const old = await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: first.token } });
    expect(old.statusCode).toBe(400); expect(old.json().error).toBe('INVITE_INVALID');
    expect((await t.app.inject({ method: 'POST', url: '/invites/resolve', headers: H(b), payload: { token: next.token } })).json().user.username).toBe('priya.dsm');

    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027' } })).json().workspace;
    const wi = (await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'workspace', workspaceId: ws.id } })).json();
    expect((await t.app.inject({ method: 'POST', url: '/invites/accept', headers: H(b), payload: { token: wi.token } })).json()).toMatchObject({ workspaceId: ws.id, alreadyMember: false });
    const again = (await t.app.inject({ method: 'POST', url: '/invites/accept', headers: H(b), payload: { token: wi.token } })).json();
    expect(again).toMatchObject({ workspaceId: ws.id, alreadyMember: true });
    expect((await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}`, headers: H(b) })).json().workspace.memberCount).toBe(2);
  });

  it('escapes LIKE wildcards in workspace member search', async () => {
    const t = setup();
    const admin = await signup(t, 'sophie.sm');
    grantPlan(t, admin, 'company');
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(admin), payload: { name: 'Hamlet UK Tour 2027' } })).json().workspace;
    t.ctx.db.prepare('INSERT INTO users (id, identifier_hash, identifier_kind, display_name, username, created_at) VALUES (?,?,?,?,?,?)')
      .run('usr_pct', 'h_pct', 'phone', '100% extra', 'pct.user', Date.now());
    t.ctx.db.prepare('INSERT INTO users (id, identifier_hash, identifier_kind, display_name, username, created_at) VALUES (?,?,?,?,?,?)')
      .run('usr_norm', 'h_norm', 'phone', 'Normal Name', 'normal.user', Date.now());
    t.joinWorkspace(ws.id, 'usr_pct', 'member', null);
    t.joinWorkspace(ws.id, 'usr_norm', 'member', null);
    const hit = (await t.app.inject({ method: 'GET', url: `/workspaces/${ws.id}/members?q=${encodeURIComponent('%')}`, headers: H(admin) })).json();
    expect(hit.members.map((m: any) => m.username)).toEqual(['pct.user']);
    expect(hit.total).toBe(1);
  });

  it('rate-limits search, messages, attachments, reports and invites', async () => {
    const t = setup();
    const a = await signup(t, 'sophie.sm'); const b = await signup(t, 'marcus.lx');
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await t.app.inject({ method: 'GET', url: '/users/search?q=ab', headers: H(a) })).statusCode;
    expect(last).toBe(429);

    const conv = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    for (let i = 0; i < 40; i++) {
      const r = await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: {} });
      expect(r.statusCode).toBe(400);
    }
    expect((await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: {} })).statusCode).toBe(429);
    expect((await t.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: {} })).json().error).toBe('RATE_LIMITED');

    for (let i = 0; i < 20; i++) await t.app.inject({ method: 'POST', url: '/attachments', headers: H(a), payload: {} });
    expect((await t.app.inject({ method: 'POST', url: '/attachments', headers: H(a), payload: {} })).statusCode).toBe(429);

    for (let i = 0; i < 8; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/reports', headers: H(a), payload: { reportedId: b.id, reason: 'spam' } });
      expect(r.statusCode).toBe(200);
    }
    expect((await t.app.inject({ method: 'POST', url: '/reports', headers: H(a), payload: { reportedId: b.id, reason: 'spam' } })).statusCode).toBe(429);

    for (let i = 0; i < 15; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'contact' } });
      expect(r.statusCode).toBe(200);
    }
    expect((await t.app.inject({ method: 'POST', url: '/invites', headers: H(a), payload: { kind: 'contact' } })).statusCode).toBe(429);
  });

  it('writes audit_log entries for wrap and role changes', async () => {
    const t = setup();
    const admin = await signup(t, 'ops.admin'); t.ctx.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(admin.id);
    const a = await signup(t, 'sophie.sm'); const b = await signup(t, 'marcus.lx');
    grantPlan(t, a, 'company');
    const ws = (await t.app.inject({ method: 'POST', url: '/workspaces', headers: H(a), payload: { name: 'Hamlet UK Tour 2027' } })).json().workspace;
    t.joinWorkspace(ws.id, b.id, 'member', null);
    await t.app.inject({ method: 'PATCH', url: `/workspaces/${ws.id}/members/${b.id}`, headers: H(a), payload: { role: 'admin' } });
    await t.app.inject({ method: 'POST', url: `/workspaces/${ws.id}/wrap`, headers: H(a) });
    const g = (await t.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'group', title: 'LX', memberIds: [b.id] } })).json().conversation;
    await t.app.inject({ method: 'PATCH', url: `/conversations/${g.id}/members/${b.id}`, headers: H(a), payload: { role: 'admin' } });
    const audit = (await t.app.inject({ method: 'GET', url: '/admin/audit', headers: H(admin) })).json();
    expect(audit.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['workspace.wrap', 'workspace.role_change', 'conversation.role_change']));
  });
});
