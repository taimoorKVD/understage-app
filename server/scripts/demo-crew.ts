/**
 * DEV ONLY. Brings the seeded colleagues to life so you can test on a phone: they log in via dev OTP,
 * listen on Socket.IO, decrypt what you send with their own keys, mark it delivered/read and reply
 * with a genuinely encrypted message. Requires `npm run seed` first and DEV_RETURN_OTP on.
 *   API_URL=http://localhost:4000 npm run demo-crew
 */
import '../src/env.js';
import fs from 'node:fs';
import { io } from 'socket.io-client';
import { encryptForRecipients, decryptPayload } from '../../shared/e2ee';

const API = process.env.API_URL || 'http://localhost:4000';
const seed = JSON.parse(fs.readFileSync('./data/seed-keys.json', 'utf8'));
const NAMES = (process.env.DEMO_CREW || 'marcus.lx,priya.dsm,jess.prog,daniel.pm,emma.wardrobe').split(',');
const REPLIES = ['Got it 👍', 'On it.', 'Copy that — will confirm at the half.', 'Thanks, see you at the stage door.', 'Noted for the plot.'];
const j = async (m: string, p: string, b?: unknown, t?: string) => (await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined })).json() as any;

for (const name of NAMES) {
  const k = seed.members[name]; if (!k) { console.warn('no seeded key for', name); continue; }
  const o = await j('POST', '/auth/otp/request', { kind: 'phone', destination: k.phone });
  const s = await j('POST', '/auth/otp/verify', { kind: 'phone', destination: k.phone, code: o.devCode });
  const token = s.accessToken as string;
  const sock = io(API, { auth: { token }, transports: ['websocket'] });
  sock.on('connect', () => console.log(`[${name}] online`));
  sock.on('message:new', async (m: any) => {
    if (m.senderId === k.userId) return;
    const conv = (await j('GET', `/conversations/${m.conversationId}`, undefined, token)).conversation;
    const sender = conv.members.find((x: any) => x.id === m.senderId);
    const plain = decryptPayload(m.nonce, m.ciphertext, sender.identityKey, k.secretKey);
    console.log(`[${name}] ← ${sender.username}: ${plain ? JSON.stringify(plain).slice(0, 80) : '(could not decrypt)'}`);
    await j('POST', '/messages/delivered', { messageIds: [m.id] }, token);
    setTimeout(async () => {
      await j('POST', `/conversations/${m.conversationId}/read`, { seq: m.seq }, token);
      if (conv.kind !== 'direct' || !plain) return;
      sock.emit('typing', { conversationId: conv.id, to: [m.senderId] });
      setTimeout(async () => {
        const text = REPLIES[Math.floor(Math.random() * REPLIES.length)];
        await j('POST', `/conversations/${conv.id}/messages`, { clientId: `demo-${Date.now()}-${name}`, payloads: encryptForRecipients({ v: 1, type: 'text', text, sentAt: Date.now() }, conv.members.map((x: any) => ({ id: x.id, publicKey: x.identityKey })), k.secretKey) }, token);
      }, 1500);
    }, 1200);
  });
}
