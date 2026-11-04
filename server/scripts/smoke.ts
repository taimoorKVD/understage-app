/** Smoke test against a LIVE server:  API_URL=http://localhost:4000 npm run smoke */
import { io } from 'socket.io-client';
import { generateIdentity, encryptForRecipients, decryptPayload } from '../../shared/e2ee';

const API = process.env.API_URL || 'http://localhost:4000';
let ok = 0;
const check = (name: string, cond: unknown) => { if (!cond) { console.error('✗', name); process.exit(1); } ok++; console.log('✓', name); };
async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
async function user(tag: string) {
  const destination = `+44779${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 9)}`;
  const r = await call('POST', '/auth/otp/request', { kind: 'phone', destination });
  check(`${tag}: OTP issued (dev code returned)`, r.json.devCode);
  const v = await call('POST', '/auth/otp/verify', { kind: 'phone', destination, code: r.json.devCode });
  check(`${tag}: verified, got tokens`, v.json.accessToken && v.json.refreshToken);
  const uname = `smoke_${tag}_${Date.now().toString(36)}`;
  await call('PATCH', '/me', { displayName: 'Smoke ' + tag, username: uname, quietHours: false }, v.json.accessToken);
  const id = generateIdentity();
  check(`${tag}: key published`, (await call('PUT', '/me/keys', { identityKey: id.publicKey }, v.json.accessToken)).status === 200);
  return { id: v.json.user.id as string, token: v.json.accessToken as string, refresh: v.json.refreshToken as string, keys: id, uname };
}

check('health', (await call('GET', '/health')).json.ok);
const a = await user('a'), b = await user('b');
const ref = await call('POST', '/auth/refresh', { refreshToken: a.refresh });
check('refresh rotates', ref.status === 200 && ref.json.refreshToken !== a.refresh); a.token = ref.json.accessToken;
const inv = await call('POST', '/invites', { kind: 'contact' }, b.token);
const acc = await call('POST', '/invites/accept', { token: inv.json.url }, a.token);
check('QR invite accepted → contact', acc.json.contact?.username === b.uname);
const sb = io(API, { auth: { token: b.token }, transports: ['websocket'] });
await new Promise<void>((res, rej) => { sb.on('connect', () => res()); sb.on('connect_error', rej); });
check('socket connected', sb.connected);
const conv = (await call('POST', '/conversations', { kind: 'direct', userId: b.id }, a.token)).json.conversation;
const recips = conv.members.map((m: any) => ({ id: m.id, publicKey: m.identityKey }));
const got = new Promise<any>(res => sb.once('message:new', res));
const sent = await call('POST', `/conversations/${conv.id}/messages`, { clientId: 'smoke-' + Date.now(), payloads: encryptForRecipients({ v: 1, type: 'text', text: 'Places please', sentAt: Date.now() }, recips, a.keys.secretKey) }, a.token);
check('encrypted message accepted', sent.status === 200);
const live = await got;
check('live delivery + decrypt', decryptPayload(live.nonce, live.ciphertext, a.keys.publicKey, b.keys.secretKey)?.type === 'text');
const st = new Promise<any>(res => { const s = io(API, { auth: { token: a.token }, transports: ['websocket'] }); s.on('message:status', d => { s.close(); res(d); }); s.on('connect', async () => { await call('POST', `/conversations/${conv.id}/read`, { seq: sent.json.message.seq }, b.token); }); });
check('read receipt pushed to sender', (await st).status === 'read');
const ws = await call('GET', '/workspaces', undefined, a.token);
check('workspaces endpoint', Array.isArray(ws.json.workspaces));
check('ICE config', (await call('GET', '/calls/ice', undefined, a.token)).json.iceServers?.length > 0);
check('plans', (await call('GET', '/subscriptions/plans')).json.plans?.length === 3);
sb.close();
console.log(`\nSMOKE OK — ${ok} checks passed against ${API}`);
process.exit(0);
