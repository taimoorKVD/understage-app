import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { io as connect, type Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import { attachRealtime, LateEmitter } from '../src/realtime';
import { MemoryPushSender, ConsoleOtpSender } from '../src/providers';
import { signup, H, type TUser } from './helpers';
import { isSealedSignal, isValidCallId } from '../../shared/call-protocol';

/** Signalling-only: these tests exercise the Socket.IO relay and call log, not WebRTC media or audio. */
const emitter = new LateEmitter();
const push = new MemoryPushSender();
const built = buildApp({ push, otp: new ConsoleOtpSender(), emit: emitter });
const t = { ...built, push, otp: new ConsoleOtpSender(), events: [] as any[] };
let url = '';
const socks: Socket[] = [];
const once = <T = any>(s: Socket, ev: string, ms = 3000) => new Promise<T>((res, rej) => { const to = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, (d: T) => { clearTimeout(to); res(d); }); });
const never = (s: Socket, ev: string, ms = 250) => new Promise<boolean>(res => { let got = false; const f = () => { got = true; }; s.once(ev, f); setTimeout(() => { s.off(ev, f); res(!got); }, ms); });
async function sock(token: string) { const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false }); socks.push(s); await once(s, 'connect'); return s; }
const sealed = (from: TUser, to: TUser, msg: unknown) => {
  const n = nacl.randomBytes(24);
  return { n: naclUtil.encodeBase64(n), c: naclUtil.encodeBase64(nacl.box(naclUtil.decodeUTF8(JSON.stringify(msg)), n, naclUtil.decodeBase64(to.id_.publicKey), naclUtil.decodeBase64(from.id_.secretKey))) };
};
const callRow = (id: string) => built.ctx.db.prepare('SELECT * FROM calls WHERE id=?').get(id) as any;
let n = 0; const cid = () => `call-sig-${++n}`;

beforeAll(async () => {
  await built.app.ready();
  attachRealtime(built.app.server, built, emitter, { ringTimeoutMs: 800, disconnectGraceMs: 300 });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(built.app.server.address() as any).port}`;
});
afterAll(async () => { socks.forEach(s => s.close()); await built.app.close(); });

describe('call signalling validation (shared/call-protocol)', () => {
  it('accepts UUID call ids and sealed boxes, rejects junk', () => {
    expect(isValidCallId('3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6')).toBe(true);
    for (const bad of ['', 'short', 'x'.repeat(65), 'has space!!', 42, null]) expect(isValidCallId(bad)).toBe(false);
    const ok = { n: naclUtil.encodeBase64(nacl.randomBytes(24)), c: naclUtil.encodeBase64(nacl.randomBytes(64)) };
    expect(isSealedSignal(ok)).toBe(true);
    expect(isSealedSignal({ type: 'offer', sdp: 'v=0' })).toBe(false); // plaintext SDP is never relayed
    expect(isSealedSignal({ n: 'abc', c: ok.c })).toBe(false);
    expect(isSealedSignal({ n: ok.n, c: 'A'.repeat(100_000) })).toBe(false);
  });
});

describe('call signalling relay (Socket.IO)', () => {
  it('rejects malformed invites, self-calls, unknown users, duplicate ids', async () => {
    const a = await signup(t as any, 'sig.alpha'); const b = await signup(t as any, 'sig.bravo');
    const sa = await sock(a.token); await sock(b.token);
    expect(await sa.emitWithAck('call:invite', { callId: 'bad id', to: b.id })).toMatchObject({ ok: false, reason: 'BAD_CALL' });
    expect(await sa.emitWithAck('call:invite', { callId: cid(), to: a.id })).toMatchObject({ ok: false, reason: 'BAD_CALL' });
    expect(await sa.emitWithAck('call:invite', { callId: cid(), to: 'u_nobody' })).toMatchObject({ ok: false, reason: 'USER_NOT_FOUND' });
    const id = cid();
    expect(await sa.emitWithAck('call:invite', { callId: id, to: b.id })).toMatchObject({ ok: true });
    sa.emit('call:end', { callId: id });
    await once(sa, 'call:ended');
    expect(await sa.emitWithAck('call:invite', { callId: id, to: b.id })).toMatchObject({ ok: false, reason: 'BAD_CALL' });
  });

  it('relays only sealed signals, only after accept, only between the two parties', async () => {
    const a = await signup(t as any, 'sig.caller'); const b = await signup(t as any, 'sig.callee');
    const sa = await sock(a.token), sb = await sock(b.token);
    const id = cid();
    const inc = once(sb, 'call:incoming');
    await sa.emitWithAck('call:invite', { callId: id, to: b.id }); await inc;
    // before accept → dropped (short never waits so we stay inside the ring window)
    const pre = never(sb, 'call:signal', 100); sa.emit('call:signal', { callId: id, data: sealed(a, b, { t: 'sdp' }) });
    expect(await pre).toBe(true);
    // caller cannot accept its own call
    const selfAcc = never(sa, 'call:accepted', 100); sa.emit('call:accept', { callId: id });
    expect(await selfAcc).toBe(true);
    const acc = once(sa, 'call:accepted'); sb.emit('call:accept', { callId: id }); await acc;
    // plaintext → dropped
    const plain = never(sb, 'call:signal'); sa.emit('call:signal', { callId: id, data: { type: 'offer', sdp: 'v=0' } });
    expect(await plain).toBe(true);
    // sealed → relayed and still decryptable by the callee only
    const env = sealed(a, b, { t: 'sdp', d: { type: 'offer', sdp: 'v=0' } });
    const got = once(sb, 'call:signal'); sa.emit('call:signal', { callId: id, data: { ...env, extra: 'stripped' } });
    const d = await got;
    expect(d).toMatchObject({ callId: id, from: a.id }); expect(Object.keys(d.data).sort()).toEqual(['c', 'n']);
    const opened = nacl.box.open(naclUtil.decodeBase64(d.data.c), naclUtil.decodeBase64(d.data.n), naclUtil.decodeBase64(a.id_.publicKey), naclUtil.decodeBase64(b.id_.secretKey));
    expect(JSON.parse(naclUtil.encodeUTF8(opened!)).d.type).toBe('offer');
    // a stranger cannot inject or end
    const c = await signup(t as any, 'sig.eve'); const sc = await sock(c.token);
    const inj = never(sa, 'call:signal'); sc.emit('call:signal', { callId: id, data: sealed(c, a, { t: 'restart' }) });
    expect(await inj).toBe(true);
    sc.emit('call:end', { callId: id }); await new Promise(r => setTimeout(r, 100));
    expect(callRow(id).ended_at).toBeNull();
    // callee can't "decline" an answered call; end works, then signals for an ended call are dropped
    sb.emit('call:decline', { callId: id }); await new Promise(r => setTimeout(r, 100));
    expect(callRow(id).ended_at).toBeNull();
    const ended = once(sa, 'call:ended'); sb.emit('call:end', { callId: id });
    expect(await ended).toMatchObject({ reason: 'hangup', status: 'completed' });
    const after = never(sb, 'call:signal'); sa.emit('call:signal', { callId: id, data: sealed(a, b, { t: 'restart' }) });
    expect(await after).toBe(true);
  });

  it('busy: a second caller gets busy while the callee is on a call; caller already in a call is refused', async () => {
    const a = await signup(t as any, 'busy.a'); const b = await signup(t as any, 'busy.b'); const c = await signup(t as any, 'busy.c');
    const sa = await sock(a.token), sb = await sock(b.token), sc = await sock(c.token);
    const id1 = cid(); await sa.emitWithAck('call:invite', { callId: id1, to: b.id });
    const id2 = cid();
    const noRing = never(sb, 'call:incoming');
    expect(await sc.emitWithAck('call:invite', { callId: id2, to: b.id })).toMatchObject({ ok: false, reason: 'busy' });
    expect(await noRing).toBe(true);
    expect(callRow(id2)).toMatchObject({ status: 'busy', end_reason: 'busy' });
    expect(await sa.emitWithAck('call:invite', { callId: cid(), to: c.id })).toMatchObject({ ok: false, reason: 'ALREADY_IN_CALL' });
    // client-side busy decline from the callee is recorded as busy
    const ended = once(sa, 'call:ended'); sb.emit('call:decline', { callId: id1, reason: 'busy' });
    expect(await ended).toMatchObject({ reason: 'busy', status: 'busy' });
    // once ended, the callee is free again
    expect(await sc.emitWithAck('call:invite', { callId: cid(), to: b.id })).toMatchObject({ ok: true });
  });

  it('declined and caller-cancelled calls end for both sides', async () => {
    const a = await signup(t as any, 'dec.a'); const b = await signup(t as any, 'dec.b');
    const sa = await sock(a.token), sb = await sock(b.token);
    const id = cid(); await sa.emitWithAck('call:invite', { callId: id, to: b.id });
    const e1 = once(sa, 'call:ended'); sb.emit('call:decline', { callId: id });
    expect(await e1).toMatchObject({ reason: 'declined', status: 'declined' });
    const id2 = cid(); await sa.emitWithAck('call:invite', { callId: id2, to: b.id });
    const e2 = once(sb, 'call:ended'); sa.emit('call:decline', { callId: id2 });
    expect(await e2).toMatchObject({ reason: 'hangup', status: 'missed' });
  });

  it('unanswered calls time out as no-answer / missed', async () => {
    const a = await signup(t as any, 'ring.a'); const b = await signup(t as any, 'ring.b');
    const sa = await sock(a.token); await sock(b.token);
    const id = cid(); await sa.emitWithAck('call:invite', { callId: id, to: b.id });
    expect(await once(sa, 'call:ended', 2000)).toMatchObject({ reason: 'no-answer', status: 'missed' });
  });

  it('an active call survives a brief socket drop but ends as disconnected after the grace window', async () => {
    const a = await signup(t as any, 'drop.a'); const b = await signup(t as any, 'drop.b');
    const sa = await sock(a.token); let sb = await sock(b.token);
    const id = cid(); await sa.emitWithAck('call:invite', { callId: id, to: b.id });
    const acc = once(sa, 'call:accepted'); sb.emit('call:accept', { callId: id }); await acc;
    sb.close(); await new Promise(r => setTimeout(r, 100));
    sb = await sock(b.token); // back inside the 300 ms grace
    await new Promise(r => setTimeout(r, 400));
    expect(callRow(id).ended_at).toBeNull();
    const env = sealed(b, a, { t: 'restart' }); const got = once(sa, 'call:signal'); sb.emit('call:signal', { callId: id, data: env }); await got;
    sb.close();
    expect(await once(sa, 'call:ended', 2000)).toMatchObject({ reason: 'disconnected', status: 'completed' });
    const log = (await built.app.inject({ method: 'GET', url: '/calls', headers: H(a) })).json().calls;
    expect(log.find((x: any) => x.id === id)).toMatchObject({ status: 'completed', endReason: 'disconnected' });
  });
});
