import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import { File, Paths } from 'expo-file-system';
import { Outbox, PermanentSendError, type OutboxItem } from '../../shared/outbox';
import { api, apiSession, ApiError, NetworkError } from './api';
import { SOCKET_URL } from './config';
import { secure, type Session } from './secure';
import { openDb, closeDb, cache, type LocalMessage, type OutboxPayload, type LocalStatus } from './db';
import { decryptPayload, encryptForRecipients, encryptBlob, decryptBlob, base64, generateIdentity, randomId, type PlainMessage, type AttachmentRef } from './crypto';
import { useApp } from '../store/app';
import { bus } from './events';
import { phoneTimezone, tzAbbr, tzCity } from './time';
import type { Conversation, SelfUser, ServerMessage, PublicUser } from './types';
import { mergeMessageList, nextSyncCursor } from '../../shared/message-sync';
import { MLS_DIRECTORY_ENABLED, publishMlsKeyPackagesAfterKeygen } from './mls';

const outbox = new Outbox<OutboxPayload>(items => { try { cache.outboxSave(items); } catch {} });
const userKeys = new Map<string, string | null>();
const localFiles = new Map<string, string>(); // clientId/attachmentId -> local file uri
let socket: Socket | null = null;
let unsubs: (() => void)[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const st = () => useApp.getState();
const set = (p: Parameters<ReturnType<typeof useApp.getState>['set']>[0]) => st().set(p);

export const getSocket = () => socket;
export const myId = () => st().me?.id ?? '';

// ------------------------------------------------------------------ session lifecycle
export async function boot() {
  const s = await secure.getSession();
  if (!s) return set({ status: 'signedOut' });
  apiSession.set(s);
  openDb(s.userId);
  let me = cache.get<SelfUser>('me');
  try { me = await api<SelfUser>('GET', '/me'); cache.set('me', me); } catch (e) { if (!(e instanceof NetworkError)) { if (e instanceof ApiError && e.status === 401) return signOutLocal(); } }
  if (!me) return set({ status: 'signedOut' });
  const identity = await secure.getIdentity(me.id);
  set({ me, identity });
  if (!me.profileComplete || !identity || me.identityKey !== identity.publicKey) return set({ status: 'onboarding' });
  set({ status: 'ready' });
  await startSession();
}

export async function signedIn(tokens: { accessToken: string; refreshToken: string }, user: SelfUser) {
  const s: Session = { ...tokens, userId: user.id };
  await secure.setSession(s);
  apiSession.set(s);
  openDb(user.id);
  cache.set('me', user);
  set({ me: user, identity: await secure.getIdentity(user.id) });
}

export function setMe(me: SelfUser) { cache.set('me', me); set({ me }); }

/** Creates the X25519 identity on this phone (Keychain) and publishes only the public half. */
export async function ensureKeys(step?: (n: number) => void) {
  const me = st().me!;
  let id = await secure.getIdentity(me.id);
  step?.(1);
  if (!id) { id = generateIdentity(); }
  step?.(2);
  await api('PUT', '/me/keys', { identityKey: id.publicKey });
  if (MLS_DIRECTORY_ENABLED) {
    const published = await publishMlsKeyPackagesAfterKeygen(me.id);
    if (!published.skipped && published.uploaded === 0) {
      throw new Error('MLS KeyPackage publish uploaded nothing');
    }
  }
  step?.(3);
  await secure.setIdentity(me.id, id);
  const fresh = await api<SelfUser>('GET', '/me');
  setMe(fresh);
  set({ identity: id });
  return id;
}

export async function finishOnboarding() { set({ status: 'ready' }); await startSession(); }

async function signOutLocal() {
  stopSocketWatch();
  socket?.disconnect(); socket = null; unsubs.forEach(u => u()); unsubs = [];
  await secure.clearSession(); apiSession.set(null);
  try { closeDb(); } catch {}
  outbox.load([]); userKeys.clear();
  set({ status: 'signedOut', me: null, identity: null, conversations: {}, convOrder: [], messages: {}, workspaces: [], heldCount: 0, socketConnected: false });
}
export async function signOut() {
  const s = apiSession.get();
  try { await api('POST', '/auth/logout', { refreshToken: s?.refreshToken }); } catch {}
  await signOutLocal();
}
apiSession.onSignedOut(() => { signOutLocal(); });

export async function startSession() {
  const convs = cache.get<Conversation[]>('convs');
  if (convs) { putConvs(convs); hydrateConversationPreviews(convs); }
  outbox.load(cache.outboxLoad());
  for (const i of outbox.pending()) if (i.payload.file) localFiles.set(i.clientId, i.payload.file.uri);
  connectSocket();
  startSocketWatch();
  unsubs.push(NetInfo.addEventListener(n => {
    const online = !!n.isConnected && n.isInternetReachable !== false;
    const was = st().online; set({ online });
    if (online && !was) wakeRealtime();
  }));
  const sub = AppState.addEventListener('change', a => { if (a === 'active') { wakeRealtime(); checkTimezone(); } });
  unsubs.push(() => sub.remove());
  await refreshAll();
  checkTimezone();
  import('./notifications').then(m => m.registerPush()).catch(() => {});
}

export async function refreshAll() {
  try {
    await refreshMe();
    await refreshConversations();
    await syncMessages();
    await syncOutgoingReceipts();
    await refreshHeld();
    api('GET', '/workspaces').then(r => set({ workspaces: r.workspaces })).catch(() => {});
  } catch (e) { if (!(e instanceof NetworkError)) console.warn('refresh', e); }
  scheduleFlush(0);
}
export async function refreshMe() { const me = await api<SelfUser>('GET', '/me'); setMe(me); return me; }
export async function refreshHeld() { const h = await api('GET', '/me/held'); set({ heldCount: h.count }); return h as { onShift: boolean; shiftStart: string; count: number; groups: { kind: string; conversationId: string | null; title: string; count: number; last: number }[] }; }

// ------------------------------------------------------------------ timezone (touring)
export async function checkTimezone() {
  const me = st().me; if (!me || !me.followPhoneTz) return;
  const tz = phoneTimezone();
  if (tz === me.timezone) return;
  try {
    const r = await api<SelfUser & { timezoneChanged: { from: string; to: string } | null }>('PATCH', '/me', { timezone: tz });
    setMe(r);
    if (r.timezoneChanged) st().showBanner({ icon: 'plane', title: `Welcome to ${tzCity(tz)} ✈️`, body: `Time zone changed to ${tzAbbr(tz)}. Your working hours ${r.touringMode ? 'moved with you' : 'stayed on ' + tzCity(r.timezoneChanged.from) + ' time'}.` });
  } catch {}
}

// ------------------------------------------------------------------ conversations
function putConvs(list: Conversation[]) {
  const map: Record<string, Conversation> = {};
  for (const c of list) { map[c.id] = c; for (const m of c.members) userKeys.set(m.id, m.identityKey); }
  set({ conversations: map, convOrder: list.map(c => c.id) });
}
export async function refreshConversations() {
  const r = await api<{ conversations: Conversation[] }>('GET', '/conversations');
  putConvs(r.conversations); cache.set('convs', r.conversations);
  hydrateConversationPreviews(r.conversations);
  return r.conversations;
}
function hydrateConversationPreviews(convs: Conversation[]) {
  const s = st();
  const messages = { ...s.messages };
  let changed = false;
  for (const c of convs) {
    if (!messages[c.id]?.length) {
      try {
        const cached = cache.messages(c.id);
        if (cached.length) { messages[c.id] = cached; changed = true; }
      } catch { /* db not open yet */ }
    }
    const list = messages[c.id];
    if (c.lastMessage) {
      if (!list?.some(m => m.body)) ingest([c.lastMessage]).catch(() => {});
      else applyMessageStatus(c.lastMessage);
    }
  }
  if (changed) set({ messages });
}
export function dropConversation(id: string) {
  const s = st();
  const conversations = { ...s.conversations }; delete conversations[id];
  const msgs = { ...s.messages }; delete msgs[id];
  const typing = { ...s.typing }; delete typing[id];
  set({ conversations, messages: msgs, typing, convOrder: s.convOrder.filter(x => x !== id) });
  try {
    cache.set('convs', (cache.get<Conversation[]>('convs') ?? []).filter(c => c.id !== id));
  } catch {}
}
let convTimer: ReturnType<typeof setTimeout> | null = null;
const refreshConvsSoon = () => { if (convTimer) clearTimeout(convTimer); convTimer = setTimeout(() => refreshConversations().catch(() => {}), 600); };
export async function refreshConversation(id: string) {
  const r = await api<{ conversation: Conversation }>('GET', `/conversations/${id}`);
  for (const m of r.conversation.members) userKeys.set(m.id, m.identityKey);
  const s = st();
  set({ conversations: { ...s.conversations, [id]: r.conversation }, convOrder: s.convOrder.includes(id) ? s.convOrder : [id, ...s.convOrder] });
  return r.conversation;
}
export async function openDirect(userId: string) {
  const r = await api<{ conversation: Conversation }>('POST', '/conversations', { kind: 'direct', userId });
  await refreshConversation(r.conversation.id); return r.conversation.id;
}
export async function createGroup(title: string, memberIds: string[]) {
  const r = await api<{ conversation: Conversation }>('POST', '/conversations', { kind: 'group', title, memberIds });
  await refreshConversation(r.conversation.id); return r.conversation.id;
}

// ------------------------------------------------------------------ messages
async function keyFor(userId: string): Promise<string | null> {
  if (userKeys.get(userId)) return userKeys.get(userId)!;
  try { const u = await api<PublicUser>('GET', `/users/${userId}`); userKeys.set(userId, u.identityKey); return u.identityKey; } catch { return null; }
}
function putLocal(m: LocalMessage) {
  const s = st();
  const list = mergeMessageList(s.messages[m.conversationId] ?? [], m);
  set({ messages: { ...s.messages, [m.conversationId]: list } });
  try { cache.upsertMessage(m); } catch {}
}
export function loadMessages(convId: string) {
  if (st().messages[convId]) return;
  try { set({ messages: { ...st().messages, [convId]: cache.messages(convId) } }); } catch {}
}
async function ingest(msgs: ServerMessage[]) {
  const me = myId(), sk = st().identity?.secretKey;
  const delivered: string[] = [];
  for (const m of msgs) {
    const existing = (st().messages[m.conversationId] ?? []).find(x => x.id === m.id || (m.senderId === me && x.clientId === m.clientId));
    let body: PlainMessage | null = existing?.body ?? null;
    if (!body && m.ciphertext && m.nonce && sk) {
      const pub = await keyFor(m.senderId);
      body = pub ? decryptPayload(m.nonce, m.ciphertext, pub, sk) : null;
      if (!body && pub) { userKeys.delete(m.senderId); const fresh = await keyFor(m.senderId); if (fresh && fresh !== pub) body = decryptPayload(m.nonce, m.ciphertext, fresh, sk); }
    }
    putLocal({ key: m.id, id: m.id, clientId: m.clientId, conversationId: m.conversationId, seq: m.seq, senderId: m.senderId, createdAt: m.createdAt, body,
      status: m.senderId === me ? ((m.status as LocalStatus) || 'sent') : 'sent', readBy: m.readBy, recipients: m.recipients, readByUserIds: m.readByUserIds, error: null });
    if (m.senderId !== me) delivered.push(m.id);
  }
  if (delivered.length) api('POST', '/messages/delivered', { messageIds: delivered }).catch(() => {});
}
export async function syncMessages() {
  let cursor = cache.get<number>('cursor') ?? 0;
  for (let i = 0; i < 20; i++) {
    const r = await api<{ messages: ServerMessage[]; cursor: number }>('GET', `/sync?since=${cursor}&limit=500`);
    await ingest(r.messages);
    cursor = nextSyncCursor(r.cursor, r.messages); cache.set('cursor', cursor);
    if (r.messages.length < 500) break;
  }
}
export async function loadOlder(convId: string) {
  const list = st().messages[convId] ?? [];
  const first = list.find(m => m.seq != null)?.seq;
  const r = await api<{ messages: ServerMessage[] }>('GET', `/conversations/${convId}/messages?limit=50${first ? `&before=${first}` : ''}`);
  await ingest(r.messages); return r.messages.length;
}
export async function markRead(convId: string) {
  const list = st().messages[convId] ?? [];
  const last = [...list].reverse().find(m => m.seq != null && m.senderId !== myId());
  const c = st().conversations[convId];
  if (c && c.unread) set({ conversations: { ...st().conversations, [convId]: { ...c, unread: 0 } } });
  if (!last?.seq || (c && last.seq <= c.lastReadSeq)) return;
  if (c) set({ conversations: { ...st().conversations, [convId]: { ...c, unread: 0, lastReadSeq: last.seq } } });
  api('POST', `/conversations/${convId}/read`, { seq: last.seq }).catch(() => {});
}

// ------------------------------------------------------------------ sending (outbox)
export function send(convId: string, plain: PlainMessage, file?: OutboxPayload['file']) {
  const clientId = randomId();
  if (file) localFiles.set(clientId, file.uri);
  const item = outbox.enqueue(clientId, convId, { plain, file });
  putLocal({ key: clientId, id: null, clientId, conversationId: convId, seq: null, senderId: myId(), createdAt: item.createdAt, body: plain, status: 'pending', readBy: 0, recipients: 0, stage: file ? 'encrypting' : null });
  scheduleFlush(0);
  return clientId;
}
export function retry(clientId: string) { outbox.retry(clientId); patchLocal(clientId, { status: 'pending', error: null }); scheduleFlush(0); }
export function discard(clientId: string) {
  const it = outbox.pending().find(i => i.clientId === clientId); outbox.remove(clientId);
  if (it) { const s = st(); set({ messages: { ...s.messages, [it.conversationId]: (s.messages[it.conversationId] ?? []).filter(m => m.clientId !== clientId) } }); try { cache.deleteMessage(clientId); } catch {} }
}
export const outboxCount = () => outbox.pending().length;
function patchLocal(clientId: string, p: Partial<LocalMessage>) {
  const s = st();
  for (const [cid, list] of Object.entries(s.messages)) {
    const i = list.findIndex(m => m.clientId === clientId && !m.id);
    if (i >= 0) { const nl = [...list]; nl[i] = { ...nl[i], ...p }; set({ messages: { ...s.messages, [cid]: nl } }); try { cache.upsertMessage(nl[i]); } catch {} return; }
  }
}
function scheduleFlush(ms: number) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await outbox.flush(sendItem, st().online, i => patchLocal(i.clientId, { status: i.state === 'sent' ? 'sent' : i.state, error: i.error ?? null }));
    const next = outbox.pending().filter(i => i.state === 'pending').map(i => i.nextAttemptAt).sort()[0];
    if (next) scheduleFlush(Math.max(500, next - Date.now()));
  }, ms);
}
export const flushNow = () => scheduleFlush(0);

async function sendItem(item: OutboxItem<OutboxPayload>) {
  const { identity } = st();
  if (!identity) throw new PermanentSendError('Encryption keys missing on this phone');
  let conv = st().conversations[item.conversationId] ?? await refreshConversation(item.conversationId);
  if (conv.readonly) throw new PermanentSendError('This chat is read-only');
  if (conv.e2eeError === 'GROUP_TOO_LARGE_FOR_E2EE') throw new PermanentSendError('This conversation is too large for end-to-end encryption');
  if (conv.kind === 'group' && conv.memberCount > conv.members.length) throw new PermanentSendError('Encrypted chat is limited to 50 members in this build');
  const noKey = conv.members.filter(m => !m.identityKey);
  if (noKey.length) { conv = await refreshConversation(conv.id); const still = conv.members.filter(m => !m.identityKey); if (still.length) throw new PermanentSendError(`${still[0].displayName || 'A member'} hasn't set up encryption yet`); }
  const p = item.payload;
  if (p.file && 'attachment' in p.plain && !p.plain.attachment.id) {
    patchLocal(item.clientId, { stage: 'encrypting' });
    const bytes = await new File(p.file.uri).bytes();
    const enc = encryptBlob(bytes);
    patchLocal(item.clientId, { stage: 'uploading' });
    const r = await wrapErr(() => api<{ id: string }>('POST', '/attachments', { conversationId: conv.id, data: enc.ciphertext }));
    p.plain = { ...p.plain, attachment: { ...p.plain.attachment, id: r.id, key: enc.key, nonce: enc.nonce } } as PlainMessage;
    localFiles.set(r.id, p.file.uri); cache.set(`file:${r.id}`, p.file.uri);
    patchLocal(item.clientId, { body: p.plain, stage: null });
  }
  const payloads = encryptForRecipients(p.plain, conv.members.map(m => ({ id: m.id, publicKey: m.identityKey! })), identity.secretKey);
  const r = await wrapErr(() => api<{ message: ServerMessage }>('POST', `/conversations/${conv.id}/messages`, { clientId: item.clientId, payloads }), conv.id);
  const m = r.message;
  putLocal({ key: m.id, id: m.id, clientId: m.clientId, conversationId: m.conversationId, seq: m.seq, senderId: m.senderId, createdAt: m.createdAt, body: p.plain, status: (m.status as LocalStatus) || 'sent', readBy: m.readBy, recipients: m.recipients, readByUserIds: m.readByUserIds });
  refreshConvsSoon();
  return { serverId: m.id };
}
async function wrapErr<T>(fn: () => Promise<T>, convId?: string): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'MISSING_RECIPIENTS' && convId) { await refreshConversation(convId); throw new Error('Group membership changed — re-encrypting'); }
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && e.status !== 401) throw new PermanentSendError(e.message);
    }
    throw e;
  }
}

// ------------------------------------------------------------------ attachments
export function localUriFor(clientId: string, att?: AttachmentRef) {
  return localFiles.get(clientId) || (att?.id ? localFiles.get(att.id) || cache.get<string>(`file:${att.id}`) || null : null);
}
export async function fetchAttachment(att: AttachmentRef): Promise<string> {
  const known = localUriFor('', att); if (known && new File(known).exists) return known;
  const ext = att.name.includes('.') ? att.name.split('.').pop() : att.mime.split('/')[1] || 'bin';
  const f = new File(Paths.cache, `att_${att.id}.${ext}`);
  if (!f.exists) {
    const r = await api<{ data: string }>('GET', `/attachments/${att.id}`);
    const bytes = decryptBlob(r.data, att.key, att.nonce);
    if (!bytes) throw new Error('Could not decrypt this file');
    f.create({ overwrite: true }); f.write(bytes);
  }
  localFiles.set(att.id, f.uri); cache.set(`file:${att.id}`, f.uri);
  return f.uri;
}

// ------------------------------------------------------------------ realtime
function applyMessageStatus(m: ServerMessage) {
  if (!m?.id || !m.conversationId) return;
  let list = st().messages[m.conversationId];
  if (!list) {
    try { list = cache.messages(m.conversationId); } catch { list = []; }
    if (list.length) set({ messages: { ...st().messages, [m.conversationId]: list } });
  }
  const x = (list ?? []).find(y => y.id === m.id || (!!m.clientId && y.clientId === m.clientId));
  if (!x) return;
  putLocal({
    ...x,
    status: (m.status as LocalStatus) || x.status,
    readBy: m.readBy,
    recipients: m.recipients,
    readByUserIds: m.readByUserIds ?? x.readByUserIds,
  });
}

async function syncOutgoingReceipts() {
  const me = myId();
  if (!me) return;
  const loaded = Object.entries(st().messages);
  for (const [convId, list] of loaded) {
    if (!list?.some(m => m.senderId === me && m.id && m.status !== 'read')) continue;
    try {
      const r = await api<{ messages: ServerMessage[] }>('GET', `/conversations/${convId}/messages?limit=50`);
      for (const m of r.messages) if (m.senderId === me) applyMessageStatus(m);
    } catch {}
  }
}

let socketWatch: ReturnType<typeof setInterval> | null = null;
function startSocketWatch() {
  if (socketWatch) return;
  socketWatch = setInterval(() => {
    if (!apiSession.get()) return;
    ensureSocket();
  }, 12_000);
}
function stopSocketWatch() {
  if (socketWatch) { clearInterval(socketWatch); socketWatch = null; }
}
function ensureSocket() {
  if (!apiSession.get()) return;
  if (!socket) connectSocket();
  else if (!socket.connected) socket.connect();
}
function wakeRealtime() {
  ensureSocket();
  refreshAll().catch(() => {});
}

function connectSocket() {
  const s = apiSession.get(); if (!s) return;
  socket?.disconnect();
  socket = io(SOCKET_URL, {
    transports: ['websocket'],
    upgrade: false,
    auth: (cb: (d: { token?: string }) => void) => cb({ token: apiSession.get()?.accessToken }),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 400,
    reconnectionDelayMax: 5_000,
    timeout: 15_000,
    randomizationFactor: 0.4,
  });
  socket.on('connect', () => { set({ socketConnected: true }); refreshAll(); });
  socket.on('disconnect', () => set({ socketConnected: false }));
  socket.on('connect_error', async (e: Error) => {
    if (e.message === 'UNAUTHORIZED') { try { await api('GET', '/me'); } catch {} } // triggers token refresh; socket retries with new token
  });
  socket.on('message:new', async (m: ServerMessage) => {
    if (!st().conversations[m.conversationId]) await refreshConversation(m.conversationId).catch(() => {});
    await ingest([m]); cache.set('cursor', nextSyncCursor(cache.get<number>('cursor') ?? 0, [m]));
    bus.emit('message:new', m); refreshConvsSoon();
  });
  socket.on('message:status', (m: ServerMessage) => { applyMessageStatus(m); });
  socket.on('typing', (d: { conversationId: string; userId: string }) => {
    const s = st(); const until = Date.now() + 4000;
    set({ typing: { ...s.typing, [d.conversationId]: [...(s.typing[d.conversationId] ?? []).filter(t => t.userId !== d.userId && t.until > Date.now()), { userId: d.userId, until }] } });
    setTimeout(() => { const t = st().typing[d.conversationId]; if (t) set({ typing: { ...st().typing, [d.conversationId]: t.filter(x => x.until > Date.now()) } }); }, 4100);
  });
  for (const ev of ['conversation:updated', 'contact:added']) socket.on(ev, (d: any) => { refreshConvsSoon(); set({ contactsVersion: st().contactsVersion + 1 }); bus.emit(ev, d); });
  socket.on('keys:changed', (d: { userId: string }) => { userKeys.delete(d.userId); refreshConvsSoon(); bus.emit('keys:changed', d); });
  for (const ev of ['announcement:new', 'announcement:ack', 'workspace:wrapped']) socket.on(ev, (d: any) => { bus.emit(ev, d); if (ev === 'workspace:wrapped') { refreshConvsSoon(); api('GET', '/workspaces').then(r => set({ workspaces: r.workspaces })).catch(() => {}); } });
  socket.on('held:released', (d: { count: number }) => { bus.emit('held:released', d); refreshHeld().catch(() => {}); });
  for (const ev of ['call:incoming', 'call:accepted', 'call:ended', 'call:signal', 'call:answered-elsewhere']) socket.on(ev, (d: any) => bus.emit(ev, d));
}
export function sendTyping(convId: string) {
  const c = st().conversations[convId]; if (!c || !socket?.connected) return;
  socket.emit('typing', { conversationId: convId, to: c.members.map(m => m.id).filter(id => id !== myId()) });
}
export const b64 = base64;
