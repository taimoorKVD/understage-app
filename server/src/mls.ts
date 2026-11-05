/**
 * OpenMLS Authentication Service / Delivery Service (Phase 2).
 *
 * The server stores opaque KeyPackage and Commit/Welcome bytes. It never sees
 * application plaintext, epoch secrets, or signature private keys.
 *
 * Gated by Config.mlsDirectoryEnabled (MLS_DIRECTORY_ENABLED=1). Default off,
 * so the existing TweetNaCl path is unchanged.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { Ctx } from './app.js';
import { HttpError, uid } from './util.js';

/** OpenMLS default KeyPackage lifetime: 3 × 28 days, plus one hour of clock-skew slack. */
export const MLS_MAX_LIFETIME_MS = (3 * 28 * 24 * 60 * 60 * 1000) + (60 * 60 * 1000);
export const MLS_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';

export function keyPackageHashRef(ciphertextB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(ciphertextB64, 'base64')).digest('hex');
}

export function isMlsDirectoryEnabled(ctx: Ctx): boolean {
  return !!ctx.cfg.mlsDirectoryEnabled;
}

export function assertMlsEnabled(ctx: Ctx): void {
  if (!isMlsDirectoryEnabled(ctx)) throw new HttpError(404, 'MLS_DISABLED', 'MLS directory is not enabled');
}

export interface MlsRouteDeps {
  auth: (req: FastifyRequest) => Promise<void>;
  getUser: (id: string) => any;
  memberOf: (convId: string, userId: string) => any;
  convMembers: (convId: string) => string[];
  rateLimit: (userId: string, bucket: string, max: number, windowMs: number) => void;
}

const b64Bytes = (min: number, max = 64 * 1024) =>
  z.string().min(1).refine(s => {
    try {
      const n = Buffer.from(s, 'base64').length;
      return n >= min && n <= max;
    } catch {
      return false;
    }
  }, 'invalid base64');

const ed25519Pub = z.string().refine(s => {
  try {
    return Buffer.from(s, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'Ed25519 public key, base64');

class EpochConflict extends Error {
  constructor(
    public epoch: number | null,
    public winningCommit: Record<string, unknown> | null,
    public catchUp: string,
  ) {
    super('Another commit was accepted at this epoch');
    this.name = 'EpochConflict';
  }
}

function serializeCommit(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    epoch: row.epoch,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
}

function serializeWelcome(row: any) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    recipientId: row.recipient_id,
    epoch: row.epoch,
    kind: 'welcome' as const,
    body: row.body,
    commitId: row.commit_id,
    createdAt: row.created_at,
  };
}

function consumeKeyPackage(ctx: Ctx, targetId: string) {
  const now = ctx.clock();
  const { db } = ctx;
  const run = db.transaction(() => {
    const ordinary = db.prepare(`
      DELETE FROM mls_key_packages
      WHERE hash_ref = (
        SELECT hash_ref FROM mls_key_packages
        WHERE user_id = ? AND last_resort = 0 AND not_before <= ? AND not_after >= ?
        ORDER BY created_at ASC, hash_ref ASC
        LIMIT 1
      )
      RETURNING *
    `).get(targetId, now, now) as any;
    if (ordinary) {
      return {
        hashRef: ordinary.hash_ref,
        userId: ordinary.user_id,
        ciphertext: ordinary.ciphertext,
        lastResort: false,
        notBefore: ordinary.not_before,
        notAfter: ordinary.not_after,
      };
    }
    const last = db.prepare(`
      SELECT * FROM mls_key_packages
      WHERE user_id = ? AND last_resort = 1 AND not_before <= ? AND not_after >= ?
      ORDER BY created_at DESC, hash_ref ASC
      LIMIT 1
    `).get(targetId, now, now) as any;
    if (!last) return null;
    db.prepare('UPDATE mls_key_packages SET last_used_at = ? WHERE hash_ref = ?').run(now, last.hash_ref);
    return {
      hashRef: last.hash_ref,
      userId: last.user_id,
      ciphertext: last.ciphertext,
      lastResort: true,
      notBefore: last.not_before,
      notAfter: last.not_after,
    };
  });
  return run.immediate();
}

export function registerMlsRoutes(app: FastifyInstance, ctx: Ctx, deps: MlsRouteDeps) {
  const { db } = ctx;
  const { auth, getUser, memberOf, convMembers, rateLimit } = deps;

  app.put('/me/mls/credential', { preHandler: auth }, async req => {
    assertMlsEnabled(ctx);
    const b = z.object({
      signaturePublicKey: ed25519Pub,
      credentialIdentity: z.string().min(1),
    }).parse(req.body);
    if (b.credentialIdentity !== req.userId) {
      throw new HttpError(400, 'IDENTITY_MISMATCH', 'credential identity must equal your user id');
    }
    const prev = getUser(req.userId) as any;
    const prevKey = prev.mls_signature_key as string | null;
    db.prepare('UPDATE users SET mls_signature_key=?, mls_credential_identity=?, mls_key_updated_at=? WHERE id=?')
      .run(b.signaturePublicKey, b.credentialIdentity, ctx.clock(), req.userId);
    if (prevKey && prevKey !== b.signaturePublicKey) {
      db.prepare('UPDATE contacts SET verified=0 WHERE contact_id=?').run(req.userId);
      for (const r of db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(req.userId) as any[]) {
        ctx.emit.toUser(r.owner_id, 'keys:changed', { userId: req.userId, protocol: 'mls' });
      }
    }
    return { ok: true, changed: !!prevKey && prevKey !== b.signaturePublicKey };
  });

  app.post('/me/key-packages', { preHandler: auth }, async req => {
    assertMlsEnabled(ctx);
    const item = z.object({
      ciphertext: b64Bytes(1),
      hashRef: z.string().min(1).optional(),
      lastResort: z.boolean(),
      notBefore: z.number().int(),
      notAfter: z.number().int(),
      credentialIdentity: z.string().min(1).optional(),
    });
    const raw = req.body as any;
    const packages = Array.isArray(raw)
      ? z.array(item).min(1).parse(raw)
      : z.object({ packages: z.array(item).min(1) }).parse(raw).packages;

    const now = ctx.clock();
    const inserted: { hashRef: string; lastResort: boolean }[] = [];
    const upload = db.transaction(() => {
      for (const pkg of packages) {
        if (pkg.credentialIdentity && pkg.credentialIdentity !== req.userId) {
          throw new HttpError(400, 'IDENTITY_MISMATCH', 'KeyPackage identity must equal your user id');
        }
        if (pkg.notAfter < now) {
          throw new HttpError(400, 'KEY_PACKAGE_EXPIRED', 'KeyPackage has already expired');
        }
        if (pkg.notAfter <= pkg.notBefore) {
          throw new HttpError(400, 'KEY_PACKAGE_LIFETIME', 'KeyPackage notAfter must be after notBefore');
        }
        if (pkg.notAfter - pkg.notBefore > MLS_MAX_LIFETIME_MS) {
          throw new HttpError(400, 'KEY_PACKAGE_LIFETIME', 'KeyPackage lifetime exceeds the three-month OpenMLS default');
        }
        const hashRef = keyPackageHashRef(pkg.ciphertext);
        if (pkg.hashRef && pkg.hashRef !== hashRef) {
          throw new HttpError(400, 'HASH_MISMATCH', 'hashRef does not match the ciphertext');
        }
        if (pkg.lastResort) {
          db.prepare('DELETE FROM mls_key_packages WHERE user_id=? AND last_resort=1').run(req.userId);
        }
        const existing = db.prepare('SELECT user_id FROM mls_key_packages WHERE hash_ref=?').get(hashRef) as any;
        if (existing) {
          throw new HttpError(409, 'HASH_EXISTS', 'A KeyPackage with this hash is already stored');
        }
        db.prepare(`
          INSERT INTO mls_key_packages (hash_ref, user_id, ciphertext, last_resort, not_before, not_after, created_at, last_used_at)
          VALUES (?,?,?,?,?,?,?,NULL)
        `).run(hashRef, req.userId, pkg.ciphertext, pkg.lastResort ? 1 : 0, pkg.notBefore, pkg.notAfter, now);
        inserted.push({ hashRef, lastResort: pkg.lastResort });
      }
    });
    upload.immediate();
    return { ok: true, uploaded: inserted.length, packages: inserted };
  });

  app.get('/me/key-packages/status', { preHandler: auth }, async req => {
    assertMlsEnabled(ctx);
    const now = ctx.clock();
    const ordinaryRemaining = (db.prepare(`
      SELECT COUNT(*) n FROM mls_key_packages
      WHERE user_id=? AND last_resort=0 AND not_before<=? AND not_after>=?
    `).get(req.userId, now, now) as any).n as number;
    const last = db.prepare(`
      SELECT * FROM mls_key_packages
      WHERE user_id=? AND last_resort=1 AND not_before<=? AND not_after>=?
      ORDER BY created_at DESC LIMIT 1
    `).get(req.userId, now, now) as any;
    return {
      ordinaryRemaining,
      lastResortRemaining: last ? 1 : 0,
      lastResortUsed: !!(last && last.last_used_at),
      lastResortLastUsedAt: last?.last_used_at ?? null,
      ciphersuite: MLS_CIPHERSUITE,
    };
  });

  app.get('/users/:id/key-package', { preHandler: auth }, async req => {
    assertMlsEnabled(ctx);
    rateLimit(req.userId, 'key-package', 60, 60_000);
    const { id } = req.params as { id: string };
    getUser(id);
    const blocked = db.prepare(
      'SELECT 1 FROM blocks WHERE (owner_id=? AND blocked_id=?) OR (owner_id=? AND blocked_id=?)',
    ).get(req.userId, id, id, req.userId);
    if (blocked) throw new HttpError(403, 'BLOCKED');
    const pkg = consumeKeyPackage(ctx, id);
    if (!pkg) throw new HttpError(404, 'KEY_PACKAGE_UNAVAILABLE', 'No unused KeyPackage is available');
    return pkg;
  });

  app.post('/conversations/:id/mls/commits', { preHandler: auth }, async (req, reply) => {
    assertMlsEnabled(ctx);
    const conversationId = (req.params as { id: string }).id;
    memberOf(conversationId, req.userId);
    const b = z.object({
      epoch: z.number().int().min(0),
      commit: b64Bytes(1),
      commitId: z.string().min(1).max(80).optional(),
      groupId: z.string().min(1).max(200).optional(),
      welcomes: z.array(z.object({
        recipientId: z.string().min(1),
        body: b64Bytes(1),
      })).default([]),
    }).parse(req.body);

    try {
      const accept = db.transaction(() => {
        const existing = db.prepare('SELECT * FROM mls_groups WHERE conversation_id=?').get(conversationId) as any;
        const storedEpoch: number | null = existing ? (existing.epoch as number | null) : null;
        const isCreate = !existing || storedEpoch === null;
        if (!isCreate && storedEpoch !== b.epoch) {
          const winning = db.prepare(`
            SELECT * FROM mls_messages
            WHERE conversation_id=? AND kind='commit'
            ORDER BY epoch DESC, created_at DESC, id DESC
            LIMIT 1
          `).get(conversationId) as any;
          throw new EpochConflict(
            storedEpoch,
            serializeCommit(winning),
            `/conversations/${conversationId}/mls?after_epoch=${Math.max((storedEpoch ?? 1) - 1, -1)}`,
          );
        }
        if (existing?.group_id && b.groupId && existing.group_id !== b.groupId) {
          throw new HttpError(400, 'GROUP_ID_MISMATCH', 'groupId does not match the stored MLS group');
        }
        const groupId = existing?.group_id || b.groupId || conversationId;
        const nextEpoch = b.epoch + 1;
        const commitId = b.commitId || uid('mlsc_');
        const now = ctx.clock();
        if (existing) {
          db.prepare('UPDATE mls_groups SET epoch=?, group_id=?, updated_at=? WHERE conversation_id=?')
            .run(nextEpoch, groupId, now, conversationId);
        } else {
          db.prepare('INSERT INTO mls_groups (conversation_id, group_id, epoch, created_at, updated_at) VALUES (?,?,?,?,?)')
            .run(conversationId, groupId, nextEpoch, now, now);
        }
        db.prepare(`
          INSERT INTO mls_messages (id, conversation_id, sender_id, epoch, kind, body, created_at)
          VALUES (?,?,?,?,?,?,?)
        `).run(commitId, conversationId, req.userId, b.epoch, 'commit', b.commit, now);
        const welcomes = [];
        for (const w of b.welcomes) {
          getUser(w.recipientId);
          const welcomeId = uid('mlsw_');
          // Persist in the same transaction as the Commit. Welcome is never
          // visible until this transaction commits (OpenMLS book: do not
          // forward a Welcome before its Commit).
          db.prepare(`
            INSERT INTO mls_welcomes (id, conversation_id, recipient_id, epoch, body, commit_id, created_at)
            VALUES (?,?,?,?,?,?,?)
          `).run(welcomeId, conversationId, w.recipientId, b.epoch, w.body, commitId, now);
          welcomes.push({ id: welcomeId, recipientId: w.recipientId, commitId });
        }
        return { commitId, groupId, epoch: nextEpoch, producedEpoch: b.epoch, welcomes };
      });
      const result = accept.immediate();
      const members = convMembers(conversationId);
      for (const m of members) {
        ctx.emit.toUser(m, 'mls:commit', {
          conversationId,
          commitId: result.commitId,
          epoch: result.epoch,
          senderId: req.userId,
        });
      }
      for (const w of result.welcomes) {
        ctx.emit.toUser(w.recipientId, 'mls:welcome', {
          conversationId,
          commitId: result.commitId,
          welcomeId: w.id,
          epoch: result.producedEpoch,
          senderId: req.userId,
        });
      }
      return { ok: true, epoch: result.epoch, commitId: result.commitId, groupId: result.groupId };
    } catch (err) {
      if (err instanceof EpochConflict) {
        return reply.status(409).send({
          error: 'EPOCH_CONFLICT',
          message: err.message,
          epoch: err.epoch,
          winningCommit: err.winningCommit,
          catchUp: err.catchUp,
        });
      }
      throw err;
    }
  });

  app.get('/conversations/:id/mls', { preHandler: auth }, async req => {
    assertMlsEnabled(ctx);
    const conversationId = (req.params as { id: string }).id;
    memberOf(conversationId, req.userId);
    const q = z.object({
      after_epoch: z.coerce.number().int().optional(),
      after_id: z.string().optional(),
    }).parse(req.query);
    const afterEpoch = q.after_epoch ?? -1;
    const group = db.prepare('SELECT * FROM mls_groups WHERE conversation_id=?').get(conversationId) as any;

    const commits = db.prepare(`
      SELECT * FROM mls_messages
      WHERE conversation_id=? AND kind='commit' AND (
        epoch > ? OR (epoch = ? AND ? IS NOT NULL AND id > ?)
      )
      ORDER BY epoch ASC, created_at ASC, id ASC
    `).all(conversationId, afterEpoch, afterEpoch, q.after_id ?? null, q.after_id ?? '') as any[];

    const welcomes = db.prepare(`
      SELECT * FROM mls_welcomes
      WHERE conversation_id=? AND recipient_id=? AND (
        epoch > ? OR (epoch = ? AND ? IS NOT NULL AND id > ?)
      )
      ORDER BY epoch ASC, created_at ASC, id ASC
    `).all(conversationId, req.userId, afterEpoch, afterEpoch, q.after_id ?? null, q.after_id ?? '') as any[];

    // Commits always precede their Welcomes at the same epoch so a joiner
    // never processes a Welcome first.
    type Item = { sortEpoch: number; sortKind: number; createdAt: number; id: string; payload: Record<string, unknown> };
    const items: Item[] = [
      ...commits.map(row => ({
        sortEpoch: row.epoch as number,
        sortKind: 0,
        createdAt: row.created_at as number,
        id: row.id as string,
        payload: serializeCommit(row)!,
      })),
      ...welcomes.map(row => ({
        sortEpoch: row.epoch as number,
        sortKind: 1,
        createdAt: row.created_at as number,
        id: row.id as string,
        payload: serializeWelcome(row),
      })),
    ];
    items.sort((a, b) =>
      a.sortEpoch - b.sortEpoch
      || a.sortKind - b.sortKind
      || a.createdAt - b.createdAt
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

    return {
      group: group
        ? { conversationId, groupId: group.group_id, epoch: group.epoch }
        : { conversationId, groupId: conversationId, epoch: null },
      messages: items.map(i => i.payload),
    };
  });
}
