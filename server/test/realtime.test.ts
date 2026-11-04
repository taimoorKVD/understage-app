import { describe, it, expect, afterAll } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import { attachRealtime, LateEmitter } from '../src/realtime';
import { MemoryPushSender, ConsoleOtpSender } from '../src/providers';
import { signup, H } from './helpers';
import { encryptForRecipients } from '../../shared/e2ee';

const emitter = new LateEmitter();
const push = new MemoryPushSender();
const built = buildApp({ push, otp: new ConsoleOtpSender(), emit: emitter });
const t = { ...built, push, otp: new ConsoleOtpSender(), events: [] as any[] };
let url = '';
const socks: Socket[] = [];
const once = <T = any>(s: Socket, ev: string) => new Promise<T>((res, rej) => { const to = setTimeout(() => rej(new Error('timeout ' + ev)), 3000); s.once(ev, (d: T) => { clearTimeout(to); res(d); }); });
async function sock(token: string) { const s = connect(url, { auth: { token }, transports: ['websocket'] }); socks.push(s); await once(s, 'connect'); return s; }

afterAll(async () => { socks.forEach(s => s.close()); await built.app.close(); });

describe('realtime (Socket.IO)', () => {
  it('rejects bad tokens, delivers message:new live, relays WebRTC signaling and call lifecycle', async () => {
    await built.app.ready();
    attachRealtime(built.app.server, built, emitter);
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(built.app.server.address() as any).port}`;
    const bad = connect(url, { auth: { token: 'nope' }, transports: ['websocket'] }); socks.push(bad);
    expect((await once<Error>(bad, 'connect_error')).message).toBe('UNAUTHORIZED');

    const a = await signup(t as any, 'sophie.sm'); const b = await signup(t as any, 'marcus.lx');
    const sa = await sock(a.token), sb = await sock(b.token);
    const conv = (await built.app.inject({ method: 'POST', url: '/conversations', headers: H(a), payload: { kind: 'direct', userId: b.id } })).json().conversation;
    const keys = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
    const live = once(sb, 'message:new');
    await built.app.inject({ method: 'POST', url: `/conversations/${conv.id}/messages`, headers: H(a), payload: { clientId: 'rt-000001', payloads: encryptForRecipients({ v: 1, type: 'text', text: 'hi', sentAt: 1 }, keys, a.id_.secretKey) } });
    const m = await live;
    expect(m.ciphertext).toBeTruthy(); expect(m.conversationId).toBe(conv.id);

    const typing = once(sb, 'typing'); sa.emit('typing', { conversationId: conv.id, to: [b.id] });
    expect((await typing).userId).toBe(a.id);

    const incoming = once(sb, 'call:incoming');
    const ack = await sa.emitWithAck('call:invite', { callId: 'call-rt-1', to: b.id });
    expect(ack.ok).toBe(true);
    expect((await incoming).callerName).toBe('sophie.sm');
    const accepted = once(sa, 'call:accepted'); sb.emit('call:accept', { callId: 'call-rt-1' }); await accepted;
    const sig = once(sb, 'call:signal'); sa.emit('call:signal', { callId: 'call-rt-1', data: { type: 'offer', sdp: 'v=0' } });
    expect((await sig).data.type).toBe('offer');
    // a stranger cannot inject signals
    const c = await signup(t as any, 'eve.x'); const sc = await sock(c.token);
    let leaked = false; sa.once('call:signal', () => { leaked = true; });
    sc.emit('call:signal', { callId: 'call-rt-1', data: { type: 'answer' } });
    await new Promise(r => setTimeout(r, 200)); expect(leaked).toBe(false);
    const ended = once(sa, 'call:ended'); sb.emit('call:end', { callId: 'call-rt-1' });
    expect((await ended).status).toBe('completed');
    const calls = (await built.app.inject({ method: 'GET', url: '/calls', headers: H(a) })).json().calls;
    expect(calls[0]).toMatchObject({ status: 'completed', direction: 'outgoing' });

    // off-shift callee with quiet hours → held, not rung
    await built.app.inject({ method: 'PATCH', url: '/me', headers: H(b), payload: { quietHours: true, workDays: [] } });
    const held = await sa.emitWithAck('call:invite', { callId: 'call-rt-2', to: b.id });
    expect(held).toMatchObject({ ok: false, reason: 'held' });
  });
});
