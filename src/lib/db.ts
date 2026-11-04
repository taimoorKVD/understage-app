import * as SQLite from 'expo-sqlite';
import type { PlainMessage } from '../../shared/e2ee';
import type { OutboxItem } from '../../shared/outbox';

/**
 * Local cache. Decrypted message bodies are cached on-device (like any messenger) so chats open instantly and work offline.
 * The DB file is protected by iOS Data Protection; the secret key itself is in the Keychain (secure.ts), not here.
 */
export type LocalStatus = 'pending' | 'sending' | 'failed' | 'sent' | 'delivered' | 'read';
export interface LocalMessage {
  key: string; id: string | null; clientId: string; conversationId: string; seq: number | null; senderId: string; createdAt: number;
  body: PlainMessage | null; status: LocalStatus; readBy: number; recipients: number; error?: string | null; stage?: 'encrypting' | 'uploading' | null;
}
export interface OutboxPayload { plain: PlainMessage; file?: { uri: string; mime: string; name: string; size: number } }

let db: SQLite.SQLiteDatabase | null = null;
export function openDb(userId: string) {
  db = SQLite.openDatabaseSync(`understage_${userId}.db`);
  db.execSync(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS msgs (key TEXT PRIMARY KEY, id TEXT, client_id TEXT, conv TEXT, seq INTEGER, sender TEXT, created_at INTEGER, body TEXT, status TEXT, read_by INTEGER, recipients INTEGER, error TEXT);
    CREATE INDEX IF NOT EXISTS msgs_conv ON msgs(conv, created_at);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS outbox (client_id TEXT PRIMARY KEY, item TEXT, created_at INTEGER);`);
  return db;
}
export function closeDb() { db?.closeSync(); db = null; }
const d = () => { if (!db) throw new Error('DB not open'); return db; };

export const cache = {
  get<T>(k: string): T | null { const r = d().getFirstSync<{ v: string }>('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : null; },
  set(k: string, v: unknown) { d().runSync('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)', k, JSON.stringify(v)); },
  upsertMessage(m: LocalMessage) {
    // a server copy replaces the optimistic one keyed by clientId
    d().runSync('DELETE FROM msgs WHERE key=? AND key!=?', m.clientId, m.key);
    d().runSync('INSERT OR REPLACE INTO msgs (key,id,client_id,conv,seq,sender,created_at,body,status,read_by,recipients,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      m.key, m.id, m.clientId, m.conversationId, m.seq, m.senderId, m.createdAt, m.body ? JSON.stringify(m.body) : null, m.status, m.readBy, m.recipients, m.error ?? null);
  },
  deleteMessage(key: string) { d().runSync('DELETE FROM msgs WHERE key=?', key); },
  messages(conv: string, limit = 300): LocalMessage[] {
    const rows = d().getAllSync<any>('SELECT * FROM (SELECT * FROM msgs WHERE conv=? ORDER BY COALESCE(seq, 9e15) DESC, created_at DESC LIMIT ?) ORDER BY COALESCE(seq, 9e15) ASC, created_at ASC', conv, limit);
    return rows.map(r => ({ key: r.key, id: r.id, clientId: r.client_id, conversationId: r.conv, seq: r.seq, senderId: r.sender, createdAt: r.created_at, body: r.body ? JSON.parse(r.body) : null, status: r.status, readBy: r.read_by, recipients: r.recipients, error: r.error }));
  },
  hasMessage(id: string) { return !!d().getFirstSync('SELECT 1 FROM msgs WHERE id=?', id); },
  outboxLoad(): OutboxItem<OutboxPayload>[] { return d().getAllSync<{ item: string }>('SELECT item FROM outbox ORDER BY created_at').map(r => JSON.parse(r.item)); },
  outboxSave(items: OutboxItem<OutboxPayload>[]) {
    const db_ = d();
    db_.withTransactionSync(() => { db_.runSync('DELETE FROM outbox'); for (const i of items) db_.runSync('INSERT INTO outbox VALUES (?,?,?)', i.clientId, JSON.stringify(i), i.createdAt); });
  },
};
