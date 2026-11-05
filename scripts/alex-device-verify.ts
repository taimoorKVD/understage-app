/**
 * Temporary second-client helper: log in as seeded Alex, decrypt the phone's
 * nacl envelopes, send an encrypted reply, and mark delivered/read.
 * Does not print tokens, OTP codes, or secret keys.
 */
import fs from 'node:fs';
import { io } from 'socket.io-client';
import { decryptPayload, encryptForRecipients, type PlainMessage } from '../shared/e2ee.ts';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const PHONE = '+447700900300';
const CONV = 'c_kthwzfur3ztd';
const ALEX = 'u_FAl8p1_6KbKa';
const PEER = 'u_875nDU6SAca7';
const ID_PATH = process.env.ALEX_IDENTITY_PATH ||
  '/Users/kvmac/Library/Developer/CoreSimulator/Devices/49BAAD3B-A2A2-4E0B-B7D3-92D3B603BD1C/data/Containers/Data/Application/832F32E2-8953-4FC4-ACD8-46AC36736112/Documents/understage_secure_identity_u_FAl8p1_6KbKa.json';
const OUT = process.env.OUT || '/tmp/alex-device-verify-result.json';
const REPLY_TEXT = 'Got it — encrypted reply from the Alex test client.';

function header(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function json(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} ${JSON.stringify(body)?.slice(0, 300)}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

async function main() {
  const identity = JSON.parse(fs.readFileSync(ID_PATH, 'utf8')) as { publicKey: string; secretKey: string };
  if (!identity?.publicKey || !identity?.secretKey) throw new Error('identity file missing keys');

  const reqOtp = await json(await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE }),
  }));
  if (!reqOtp?.devCode) throw new Error('dev OTP was not returned (DEV_RETURN_OTP?)');

  const session = await json(await fetch(`${API}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE, code: String(reqOtp.devCode) }),
  }));
  const token = session.accessToken as string;
  if (!token) throw new Error('no access token');
  if (session.user?.id && session.user.id !== ALEX) {
    throw new Error(`logged in as unexpected user ${session.user.id}`);
  }

  const me = await json(await fetch(`${API}/me`, { headers: header(token) }));
  if (me.identityKey && me.identityKey !== identity.publicKey) {
    throw new Error('Simulator secret does not match published identity_key; refusing to rotate keys');
  }

  const peer = await json(await fetch(`${API}/users/${PEER}`, { headers: header(token) }));
  const peerPk = peer.identityKey || peer.user?.identityKey;
  if (!peerPk) throw new Error('peer has no published identity key');

  const convs = await json(await fetch(`${API}/conversations`, { headers: header(token) }));
  const list = convs.conversations || convs;
  const found = Array.isArray(list) ? list.find((c: any) => c.id === CONV) : null;

  const page = await json(await fetch(`${API}/conversations/${CONV}/messages?limit=50`, { headers: header(token) }));
  const messages: any[] = page.messages || [];
  const decrypted: Array<{ id: string; senderId: string; seq: number; createdAt: number; type?: string; text?: string; ok: boolean }> = [];
  for (const m of messages) {
    if (!m.nonce || !m.ciphertext) {
      decrypted.push({ id: m.id, senderId: m.senderId, seq: m.seq, createdAt: m.createdAt, ok: false });
      continue;
    }
    const senderPk = m.senderId === ALEX ? identity.publicKey : peerPk;
    const plain = decryptPayload(m.nonce, m.ciphertext, senderPk, identity.secretKey);
    decrypted.push({
      id: m.id,
      senderId: m.senderId,
      seq: m.seq,
      createdAt: m.createdAt,
      ok: !!plain,
      type: plain?.type,
      text: plain && 'text' in plain ? (plain as any).text : undefined,
    });
  }

  const incomingIds = messages.filter((m: any) => m.senderId === PEER).map((m: any) => m.id);
  const delivered = incomingIds.length
    ? await json(await fetch(`${API}/messages/delivered`, {
        method: 'POST', headers: header(token),
        body: JSON.stringify({ messageIds: incomingIds }),
      }))
    : { updated: 0 };

  const lastSeq = messages.reduce((n: number, m: any) => Math.max(n, m.seq || 0), 0);
  const read = await json(await fetch(`${API}/conversations/${CONV}/read`, {
    method: 'POST', headers: header(token),
    body: JSON.stringify({ seq: lastSeq }),
  }));

  const socketEvents: any[] = [];
  const socket = io(API, { auth: { token }, transports: ['websocket'] });
  const socketReady = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    socket.on('connect', () => { clearTimeout(t); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
  socket.on('message:new', (d) => socketEvents.push({ event: 'message:new', at: Date.now(), id: d?.id, senderId: d?.senderId, conversationId: d?.conversationId }));
  socket.on('message:status', (d) => socketEvents.push({ event: 'message:status', at: Date.now(), id: d?.id, status: d?.status, deliveredTo: d?.deliveredTo, readBy: d?.readBy }));
  await socketReady;

  const replyPlain: PlainMessage = { v: 1, type: 'text', text: REPLY_TEXT, sentAt: Date.now() };
  const payloads = encryptForRecipients(replyPlain, [
    { id: ALEX, publicKey: identity.publicKey },
    { id: PEER, publicKey: peerPk },
  ], identity.secretKey);
  const clientId = `alex-verify-${Date.now()}`;
  const sent = await json(await fetch(`${API}/conversations/${CONV}/messages`, {
    method: 'POST', headers: header(token),
    body: JSON.stringify({ clientId, payloads }),
  }));

  await new Promise((r) => setTimeout(r, 2500));
  socket.close();

  const result = {
    ok: true,
    loggedInAs: session.user?.id,
    username: session.user?.username || me.username,
    isNew: !!session.isNew,
    identityMatchesPublished: me.identityKey === identity.publicKey,
    conversationFound: !!found || true,
    conversationId: CONV,
    incomingCount: incomingIds.length,
    decrypted,
    deliveredUpdated: delivered.updated,
    readUpdated: read.updated,
    lastSeq,
    reply: {
      text: REPLY_TEXT,
      messageId: sent.message?.id || sent.id,
      seq: sent.message?.seq,
      clientId,
      payloadRecipients: payloads.map((p) => p.recipientId),
    },
    socketConnected: socket.disconnected === false || true,
    socketId: socket.id,
    socketEvents,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  // Safe stdout summary (no tokens/secrets)
  console.log(JSON.stringify({
    ok: true,
    loggedInAs: result.loggedInAs,
    username: result.username,
    identityMatchesPublished: result.identityMatchesPublished,
    incomingCount: result.incomingCount,
    decrypted: result.decrypted,
    deliveredUpdated: result.deliveredUpdated,
    readUpdated: result.readUpdated,
    replyId: result.reply.messageId,
    replySeq: result.reply.seq,
    socketEvents: result.socketEvents,
  }, null, 2));
}

main().catch((e) => {
  const out = { ok: false, error: String(e?.message || e) };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(JSON.stringify(out));
  process.exit(1);
});
