#!/usr/bin/env python3
"""Apply OpenMLS Phase 2 AS/DS patches. Idempotent."""
from pathlib import Path
import sys

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")

def read(rel: str) -> str:
    return (ROOT / rel).read_text()

def write(rel: str, text: str) -> None:
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    print(f"wrote {rel} ({len(text.splitlines())} lines)")

def once(text: str, needle: str, insert: str, label: str) -> str:
    if insert.strip() in text or needle + insert in text:
        print(f"skip already present: {label}")
        return text
    if needle not in text:
        raise SystemExit(f"marker not found for {label}: {needle[:80]!r}")
    print(f"patch {label}")
    return text.replace(needle, insert, 1)

# ---- copy new server files ----
src_dir = Path(__file__).resolve().parent
for name, dest in [
    ("mls.ts", "server/src/mls.ts"),
    ("mls-directory.test.ts", "server/test/mls-directory.test.ts"),
]:
    write(dest, (src_dir / name).read_text())

# ---- config.ts ----
cfg = read("server/src/config.ts")
cfg = once(
    cfg,
    "  turnUsername?: string;\n  turnCredential?: string;\n}",
    "  turnUsername?: string;\n  turnCredential?: string;\n  /** OpenMLS AS/DS directory. Default off so the nacl path stays live. */\n  mlsDirectoryEnabled: boolean;\n}",
    "config interface field",
)
cfg = once(
    cfg,
    "    turnUsername: env.TURN_USERNAME,\n    turnCredential: env.TURN_CREDENTIAL,\n    ...over,",
    "    turnUsername: env.TURN_USERNAME,\n    turnCredential: env.TURN_CREDENTIAL,\n    mlsDirectoryEnabled: env.MLS_DIRECTORY_ENABLED === '1',\n    ...over,",
    "config load field",
)
write("server/src/config.ts", cfg)

# ---- db.ts ----
db = read("server/src/db.ts")
db = once(
    db,
    "  identity_key TEXT,                          -- X25519 public key (base64)\n  key_updated_at INTEGER,\n",
    "  identity_key TEXT,                          -- X25519 public key (base64)\n  key_updated_at INTEGER,\n  mls_signature_key TEXT,                     -- Ed25519 signature public key (base64)\n  mls_credential_identity TEXT,\n  mls_key_updated_at INTEGER,\n",
    "users MLS columns",
)
MLS_TABLES = """
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
"""
db = once(
    db,
    "CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);\n",
    MLS_TABLES + "CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);\n",
    "MLS tables",
)
MIGRATE = '''
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

'''
if "export function migrateMls" not in db:
    db = once(
        db,
        "export function openDb(file = ':memory:'): DB {\n  const db = new Database(file);\n  db.exec(SCHEMA);\n  return db;\n}\n",
        MIGRATE + "export function openDb(file = ':memory:'): DB {\n  const db = new Database(file);\n  db.exec(SCHEMA);\n  migrateMls(db);\n  return db;\n}\n",
        "openDb migrateMls",
    )
else:
    print("skip already present: migrateMls")
write("server/src/db.ts", db)

# ---- app.ts ----
app = read("server/src/app.ts")
app = once(
    app,
    "import { ConsoleOtpSender, MemoryPushSender, type OtpSender, type PushSender } from './providers.js';\n",
    "import { ConsoleOtpSender, MemoryPushSender, type OtpSender, type PushSender } from './providers.js';\nimport { registerMlsRoutes } from './mls.js';\n",
    "app.ts import",
)
app = once(
    app,
    "    avatar: u.avatar ?? null, identityKey: u.identity_key ?? null, keyUpdatedAt: u.key_updated_at ?? null,\n",
    "    avatar: u.avatar ?? null, identityKey: u.identity_key ?? null, keyUpdatedAt: u.key_updated_at ?? null,\n"
    "    ...(ctx.cfg.mlsDirectoryEnabled ? {\n"
    "      mlsSignaturePublicKey: u.mls_signature_key ?? null,\n"
    "      mlsCredentialIdentity: u.mls_credential_identity ?? null,\n"
    "      mlsKeyUpdatedAt: u.mls_key_updated_at ?? null,\n"
    "    } : {}),\n",
    "publicUser MLS fields",
)
app = once(
    app,
    "  app.get('/health', async () => ({ ok: true, time: ctx.clock() }));\n",
    "  app.get('/health', async () => ({ ok: true, time: ctx.clock(), mlsDirectory: !!ctx.cfg.mlsDirectoryEnabled }));\n",
    "health mlsDirectory",
)
app = once(
    app,
    "  return { app, ctx, jobs, calls, joinWorkspace };\n",
    "  registerMlsRoutes(app, ctx, { auth, getUser, memberOf, convMembers, rateLimit });\n\n"
    "  return { app, ctx, jobs, calls, joinWorkspace };\n",
    "registerMlsRoutes",
)
write("server/src/app.ts", app)

# ---- helpers.ts ----
helpers = read("server/test/helpers.ts")
helpers = once(
    helpers,
    "export function setup(clock?: () => number) {\n  const push = new MemoryPushSender();\n  const otp = new ConsoleOtpSender();\n  const events: { user: string; event: string; data: any }[] = [];\n  const built = buildApp({ push, otp, clock, emit: { toUser: (user, event, data) => { events.push({ user, event, data }); }, isOnline: () => false } });\n  return { ...built, push, otp, events };\n}\n",
    "export function setup(clock?: () => number, cfg?: { mlsDirectoryEnabled?: boolean }) {\n  const push = new MemoryPushSender();\n  const otp = new ConsoleOtpSender();\n  const events: { user: string; event: string; data: any }[] = [];\n  const built = buildApp({ push, otp, clock, cfg, emit: { toUser: (user, event, data) => { events.push({ user, event, data }); }, isOnline: () => false } });\n  return { ...built, push, otp, events };\n}\n",
    "helpers setup cfg",
)
write("server/test/helpers.ts", helpers)

# ---- types.ts ----
types = read("src/lib/types.ts")
types = once(
    types,
    "  identityKey: string | null; keyUpdatedAt: number | null; timezone: string; localTime: string; onShift: boolean; shift: Shift;\n",
    "  identityKey: string | null; keyUpdatedAt: number | null; timezone: string; localTime: string; onShift: boolean; shift: Shift;\n"
    "  mlsSignaturePublicKey?: string | null; mlsCredentialIdentity?: string | null; mlsKeyUpdatedAt?: number | null;\n",
    "PublicUser MLS fields",
)
write("src/lib/types.ts", types)

# ---- shared/e2ee.ts ----
e2ee = read("shared/e2ee.ts")
MLS_SAFETY = '''
/** 60-digit safety number bound to MLS Ed25519 credentials (same 12-group UX). */
export function mlsSafetyNumber(
  a: { id: string; signaturePublicKey: string },
  b: { id: string; signaturePublicKey: string },
): string[] {
  const [x, y] = [a, b].sort((p, q) => (p.id < q.id ? -1 : 1));
  let h: Uint8Array = decodeUTF8('understage-mls-safety-v1:' + x.id + ':' + x.signaturePublicKey + ':' + y.id + ':' + y.signaturePublicKey);
  h = nacl.hash(h);
  let s = '';
  for (let i = 0; i < 30; i += 5) {
    const n = h[i] * 2 ** 32 + h[i + 1] * 2 ** 24 + h[i + 2] * 2 ** 16 + h[i + 3] * 2 ** 8 + h[i + 4];
    s += String(n % 100000).padStart(5, '0');
  }
  const extra = nacl.hash(h);
  for (let i = 0; i < 30; i += 5) {
    const n = extra[i] * 2 ** 32 + extra[i + 1] * 2 ** 24 + extra[i + 2] * 2 ** 16 + extra[i + 3] * 2 ** 8 + extra[i + 4];
    s += String(n % 100000).padStart(5, '0');
  }
  return s.match(/.{5}/g)!;
}

/** Prefer the MLS number when both sides have published credentials; otherwise the legacy TweetNaCl number. */
export function conversationSafetyNumber(
  a: { id: string; publicKey: string; mlsSignaturePublicKey?: string | null },
  b: { id: string; publicKey: string; mlsSignaturePublicKey?: string | null },
): string[] | null {
  if (a.mlsSignaturePublicKey && b.mlsSignaturePublicKey) {
    return mlsSafetyNumber(
      { id: a.id, signaturePublicKey: a.mlsSignaturePublicKey },
      { id: b.id, signaturePublicKey: b.mlsSignaturePublicKey },
    );
  }
  if (a.publicKey && b.publicKey) return safetyNumber({ id: a.id, publicKey: a.publicKey }, { id: b.id, publicKey: b.publicKey });
  return null;
}
'''
if "export function mlsSafetyNumber" not in e2ee:
    e2ee = once(
        e2ee,
        "export const base64 = { encode: b64, decode: unb64 };\n",
        MLS_SAFETY + "\nexport const base64 = { encode: b64, decode: unb64 };\n",
        "mlsSafetyNumber",
    )
write("shared/e2ee.ts", e2ee)

# ---- safety screen (same layout; swap number source only) ----
safety_rel = "src/app/(app)/safety/[id].tsx"
safety = read(safety_rel)
safety = once(
    safety,
    "import { safetyNumber } from '../../../lib/crypto';\n",
    "import { conversationSafetyNumber } from '../../../lib/crypto';\n",
    "safety import",
)
safety = once(
    safety,
    "  const num = peer.identityKey ? safetyNumber({ id: me.id, publicKey: identity.publicKey }, { id: peer.id, publicKey: peer.identityKey }) : null;\n",
    "  const num = conversationSafetyNumber(\n"
    "    { id: me.id, publicKey: identity.publicKey, mlsSignaturePublicKey: me.mlsSignaturePublicKey },\n"
    "    { id: peer.id, publicKey: peer.identityKey ?? '', mlsSignaturePublicKey: peer.mlsSignaturePublicKey },\n"
    "  );\n",
    "safety number source",
)
write(safety_rel, safety)

# ---- src/lib/mls.ts publish helper ----
mls_client = read("src/lib/mls.ts")
PUBLISH = '''
import { api } from './api';

/** Client flag (default off). Set EXPO_PUBLIC_MLS_DIRECTORY=1 to publish after keygen. */
export const MLS_DIRECTORY_ENABLED = process.env.EXPO_PUBLIC_MLS_DIRECTORY === '1';
export const MLS_KEY_PACKAGE_BATCH = 20;
export const MLS_KEY_PACKAGE_WATERMARK = 5;
export const MLS_KEY_PACKAGE_LIFETIME_MS = 3 * 28 * 24 * 60 * 60 * 1000;

export type MlsPublishResult = {
  uploaded: number;
  skipped: boolean;
  reason?: string;
};

/**
 * After TweetNaCl keygen, optionally generate an MLS credential and upload a
 * batch of KeyPackages plus one last-resort package. No-ops unless the feature
 * flag is on and the native module is present. Does not change the nacl send path.
 *
 * The current native module does not export the Ed25519 signature public key
 * (exporting it would require a UniFFI API change and a native rebuild, which
 * Phase 2 was asked not to do without reporting back first). KeyPackages are
 * still published; PUT /me/mls/credential can be called once that export exists.
 */
export async function publishMlsKeyPackagesAfterKeygen(userId: string): Promise<MlsPublishResult> {
  if (!MLS_DIRECTORY_ENABLED) {
    return { uploaded: 0, skipped: true, reason: 'disabled' };
  }
  if (!mlsAvailable()) {
    return { uploaded: 0, skipped: true, reason: 'native-unavailable' };
  }
  const root = mlsDocumentsDirectory().replace(/\\/+$/, '');
  const session = await mlsOpenSession(`${root}/mls/${userId}.sqlite`);
  try {
    try {
      await mlsGenerateCredential(session, userId);
    } catch {
      // Session may already hold a credential from a previous publish.
    }
    const now = Date.now();
    const notBefore = now - 60 * 60 * 1000;
    const notAfter = notBefore + MLS_KEY_PACKAGE_LIFETIME_MS;
    const packages: { ciphertext: string; lastResort: boolean; notBefore: number; notAfter: number; credentialIdentity: string }[] = [];
    for (let i = 0; i < MLS_KEY_PACKAGE_BATCH; i++) {
      const ciphertext = await mlsExportKeyPackage(session);
      packages.push({ ciphertext, lastResort: false, notBefore, notAfter, credentialIdentity: userId });
    }
    packages.push({
      ciphertext: await mlsExportKeyPackage(session),
      lastResort: true,
      notBefore,
      notAfter,
      credentialIdentity: userId,
    });
    await api('POST', '/me/key-packages', { packages });
    return { uploaded: packages.length, skipped: false };
  } finally {
    await mlsCloseSession(session).catch(() => undefined);
  }
}
'''
if "export async function publishMlsKeyPackagesAfterKeygen" not in mls_client:
    # insert import after existing imports and append helpers at end
    mls_client = once(
        mls_client,
        "import { requireNativeModule } from 'expo-modules-core';\n",
        "import { requireNativeModule } from 'expo-modules-core';\nimport { api } from './api';\n",
        "mls.ts api import",
    )
    mls_client = mls_client.rstrip() + "\n\n" + PUBLISH.replace("import { api } from './api';\n\n", "")
    print("patch mls.ts publish helper")
write("src/lib/mls.ts", mls_client)

# ---- engine.ts ----
engine = read("src/lib/engine.ts")
engine = once(
    engine,
    "import type { Conversation, SelfUser, ServerMessage, PublicUser } from './types';\n",
    "import type { Conversation, SelfUser, ServerMessage, PublicUser } from './types';\n"
    "import { MLS_DIRECTORY_ENABLED, publishMlsKeyPackagesAfterKeygen } from './mls';\n",
    "engine mls import",
)
engine = once(
    engine,
    "  await api('PUT', '/me/keys', { identityKey: id.publicKey });\n  step?.(3);\n  await secure.setIdentity(me.id, id);\n",
    "  await api('PUT', '/me/keys', { identityKey: id.publicKey });\n"
    "  if (MLS_DIRECTORY_ENABLED) {\n"
    "    const published = await publishMlsKeyPackagesAfterKeygen(me.id);\n"
    "    if (!published.skipped && published.uploaded === 0) {\n"
    "      throw new Error('MLS KeyPackage publish uploaded nothing');\n"
    "    }\n"
    "  }\n"
    "  step?.(3);\n"
    "  await secure.setIdentity(me.id, id);\n",
    "engine publish after keygen",
)
write("src/lib/engine.ts", engine)

print("OK")
