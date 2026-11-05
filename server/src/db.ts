import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  identifier_hash TEXT UNIQUE NOT NULL,      -- sha256(pepper + phone/email). Raw phone is never stored.
  identifier_kind TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  identity_key TEXT,                          -- X25519 public key (base64)
  key_updated_at INTEGER,
  mls_signature_key TEXT,                     -- Ed25519 signature public key (base64)
  mls_credential_identity TEXT,
  mls_key_updated_at INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  follow_phone_tz INTEGER NOT NULL DEFAULT 1,
  touring_mode INTEGER NOT NULL DEFAULT 0,
  quiet_hours INTEGER NOT NULL DEFAULT 1,
  work_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5]', -- 0=Mon..6=Sun
  shift_start TEXT NOT NULL DEFAULT '12:00',
  shift_end TEXT NOT NULL DEFAULT '23:30',
  work_mode INTEGER NOT NULL DEFAULT 1,
  is_admin INTEGER NOT NULL DEFAULT 0,
  suspended_until INTEGER,
  suspension_reason TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_status TEXT,
  plan_renews_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, contact_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  owner_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, initial TEXT NOT NULL, venue TEXT NOT NULL DEFAULT '',
  run_label TEXT NOT NULL DEFAULT '', seat_limit INTEGER NOT NULL DEFAULT 200, plan TEXT NOT NULL DEFAULT 'company',
  wrapped_at INTEGER, delete_after INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', department_id TEXT, city TEXT NOT NULL DEFAULT '', joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, workspace_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL, client_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'e2ee', created_at INTEGER NOT NULL,
  UNIQUE (sender_id, client_id)
);
-- one ciphertext per recipient (including sender's own copy). Server never sees plaintext.
CREATE TABLE IF NOT EXISTS message_payloads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY (message_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  delivered_at INTEGER, read_at INTEGER, PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, author_id TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, require_ack INTEGER NOT NULL DEFAULT 0, respect_quiet INTEGER NOT NULL DEFAULT 1,
  department_ids TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcement_recipients (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  seen_at INTEGER, acked_at INTEGER, reminded_at INTEGER, PRIMARY KEY (announcement_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, reason TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]', also_blocked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS suspensions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, duration TEXT NOT NULL, reason TEXT NOT NULL, until INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, lifted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS held_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, conversation_id TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, released_at INTEGER
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, callee_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER, end_reason TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS mls_key_packages (
  hash_ref TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  last_resort INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS mls_groups (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  epoch INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mls_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mls_welcomes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  body TEXT NOT NULL,
  commit_id TEXT NOT NULL REFERENCES mls_messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mls_kp_user ON mls_key_packages(user_id, last_resort, not_after, created_at);
CREATE INDEX IF NOT EXISTS idx_mls_msg_conv ON mls_messages(conversation_id, epoch, created_at);
CREATE INDEX IF NOT EXISTS idx_mls_welcome_rcpt ON mls_welcomes(conversation_id, recipient_id, epoch);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_payload_rcpt ON message_payloads(recipient_id);
CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(user_id);
`;


function columnNames(db: DB, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name));
}

/** Additive MLS columns/tables for databases created before Phase 2. */
export function migrateMls(db: DB) {
  const cols = columnNames(db, 'users');
  if (!cols.has('mls_signature_key')) db.exec('ALTER TABLE users ADD COLUMN mls_signature_key TEXT');
  if (!cols.has('mls_credential_identity')) db.exec('ALTER TABLE users ADD COLUMN mls_credential_identity TEXT');
  if (!cols.has('mls_key_updated_at')) db.exec('ALTER TABLE users ADD COLUMN mls_key_updated_at INTEGER');
}

export function openDb(file = ':memory:'): DB {
  const db = new Database(file);
  db.exec(SCHEMA);
  migrateMls(db);
  return db;
}
