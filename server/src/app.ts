import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerRequestLogging } from './http-log.js';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { openDb, type DB } from './db.js';
import { loadConfig, type Config } from './config.js';
import { HttpError, isOnShift, localParts, now, sha256, uid } from './util.js';
import { genOtp, identifierHash, issueSession, rotateRefresh, validateDestination, verifyAccess } from './auth.js';
import { signInvite, verifyInvite } from './invites.js';
import { ConsoleOtpSender, MemoryPushSender, type OtpSender, type PushSender } from './providers.js';
import { registerMlsRoutes } from './mls.js';
import { iapVerificationReady, loadTrustedRootPems, planFromProductId, verifySignedTransaction } from './iap.js';

export interface Emitter { toUser(userId: string, event: string, data: unknown): void; isOnline(userId: string): boolean }
const nullEmitter: Emitter = { toUser() {}, isOnline() { return false; } };

export interface Ctx {
  db: DB; cfg: Config; otp: OtpSender; push: PushSender; emit: Emitter; clock: () => number;
}

declare module 'fastify' { interface FastifyRequest { userId: string } }

const DAY = 86400_000;
export const PLANS = [
  { id: 'free', name: 'Crew', description: '1:1 & group chats, calls', priceGBP: 0, period: 'forever', seats: 0, productId: null },
  { id: 'production', name: 'Production', description: 'Workspace up to 50 people', priceGBP: 49, period: 'month', seats: 50, productId: 'com.understage.production.monthly' },
  { id: 'company', name: 'Company', description: 'Up to 200 people + admin tools', priceGBP: 149, period: 'month', seats: 200, productId: 'com.understage.company.monthly' },
];
export const E2EE_GROUP_LIMIT = 50;

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, ch => '\\' + ch);
}

// ---------- serializers
export function publicUser(ctx: Ctx, u: any, viewerId?: string) {
  const lp = localParts(u.timezone, ctx.clock());
  return {
    id: u.id, displayName: u.display_name, username: u.username, role: u.role, department: u.department,
    avatar: u.avatar ?? null, identityKey: u.identity_key ?? null, keyUpdatedAt: u.key_updated_at ?? null,
    ...(ctx.cfg.mlsDirectoryEnabled ? {
      mlsSignaturePublicKey: u.mls_signature_key ?? null,
      mlsCredentialIdentity: u.mls_credential_identity ?? null,
      mlsKeyUpdatedAt: u.mls_key_updated_at ?? null,
    } : {}),
    timezone: u.timezone, localTime: lp.hhmm, onShift: isOnShift(u, ctx.clock()),
    shift: { start: u.shift_start, end: u.shift_end, days: JSON.parse(u.work_days) },
    ...(viewerId ? {} : {}),
  };
}
function selfUser(ctx: Ctx, u: any) {
  return {
    ...publicUser(ctx, u), identifierKind: u.identifier_kind, followPhoneTz: !!u.follow_phone_tz, touringMode: !!u.touring_mode,
    quietHours: !!u.quiet_hours, workMode: !!u.work_mode, isAdmin: !!u.is_admin, plan: u.plan, planStatus: u.plan_status,
    planRenewsAt: u.plan_renews_at, profileComplete: !!(u.username && u.display_name),
  };
}

export function buildApp(opts: Omit<Partial<Ctx>, 'cfg'> & { cfg?: Partial<Config> } = {}) {
  const cfg = loadConfig(opts.cfg);
  const ctx: Ctx = {
    db: opts.db || openDb(':memory:'), cfg, otp: opts.otp || new ConsoleOtpSender(), push: opts.push || new MemoryPushSender(),
    emit: opts.emit || nullEmitter, clock: opts.clock || now,
  };
  const { db } = ctx;
  const rateBuckets = new Map<string, number[]>();
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 40 * 1024 * 1024 });
  registerRequestLogging(app);
  app.register(cors, { origin: true });
  app.decorateRequest('userId', '');

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'VALIDATION', message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code || 'BAD_REQUEST', message: err.message });
    console.error(err);
    return reply.status(500).send({ error: 'INTERNAL' });
  });

  const auth = async (req: FastifyRequest) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHORIZED');
    req.userId = verifyAccess(db, cfg, h.slice(7)).sub;
  };
  const adminAuth = async (req: FastifyRequest) => {
    const t = req.headers['x-admin-token'];
    if (cfg.adminToken && t === cfg.adminToken) { req.userId = 'admin'; return; }
    await auth(req);
    const u = getUser(req.userId);
    if (!u.is_admin) throw new HttpError(403, 'FORBIDDEN');
  };

  // ---------- helpers
  const getUser = (id: string): any => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND');
    return u;
  };
  const isBlocked = (a: string, b: string) => !!db.prepare('SELECT 1 FROM blocks WHERE (owner_id=? AND blocked_id=?) OR (owner_id=? AND blocked_id=?)').get(a, b, b, a);
  const memberOf = (convId: string, userId: string) => {
    const m = db.prepare('SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?').get(convId, userId) as any;
    if (!m) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
    return m;
  };
  const wsMember = (wsId: string, userId: string) => {
    const m = db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(wsId, userId) as any;
    if (!m) throw new HttpError(404, 'WORKSPACE_NOT_FOUND');
    return m;
  };
  const wsAdmin = (wsId: string, userId: string) => {
    const m = wsMember(wsId, userId);
    if (!['owner', 'admin'].includes(m.role)) throw new HttpError(403, 'ADMIN_ONLY', 'Only workspace admins can do this');
    return m;
  };
  const getWs = (id: string): any => {
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    if (!w) throw new HttpError(404, 'WORKSPACE_NOT_FOUND');
    return w;
  };
  const entitledPlan = (userId: string) => {
    const u = getUser(userId);
    const plan = PLANS.find(p => p.id === u.plan) || PLANS[0];
    const status = u.plan_status as string | null;
    const expired = status === 'expired' || status === 'cancelled' || (!!u.plan_renews_at && u.plan_renews_at < ctx.clock() && status === 'trial');
    if (plan.id === 'free' || plan.seats <= 0 || expired) return { id: 'free' as const, seats: 0, status: expired ? 'expired' : status };
    return { id: plan.id as 'production' | 'company' | 'free', seats: plan.seats, status };
  };
  const writeAudit = (actorId: string | null, action: string, targetType: string | null, targetId: string | null, meta: Record<string, unknown> = {}) => {
    db.prepare('INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, meta) VALUES (?,?,?,?,?,?,?)')
      .run(uid('al_'), ctx.clock(), actorId, action, targetType, targetId, JSON.stringify(meta));
  };
  const rateLimit = (userId: string, bucket: string, max: number, windowMs: number) => {
    const now = ctx.clock();
    const key = `${userId}:${bucket}`;
    const arr = (rateBuckets.get(key) || []).filter(x => x > now - windowMs);
    if (arr.length >= max) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
    arr.push(now);
    rateBuckets.set(key, arr);
  };
  const canViewUser = (viewerId: string, targetId: string, inviteToken?: string) => {
    if (viewerId === targetId) return true;
    if (db.prepare('SELECT 1 FROM contacts WHERE (owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)').get(viewerId, targetId, targetId, viewerId)) return true;
    if (db.prepare('SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id=b.conversation_id WHERE a.user_id=? AND b.user_id=?').get(viewerId, targetId)) return true;
    if (db.prepare('SELECT 1 FROM workspace_members a JOIN workspace_members b ON a.workspace_id=b.workspace_id WHERE a.user_id=? AND b.user_id=?').get(viewerId, targetId)) return true;
    if (inviteToken) {
      try {
        const payload = verifyInvite(cfg, inviteToken, ctx.clock());
        const inv = db.prepare('SELECT * FROM invites WHERE id=?').get(payload.id) as any;
        if (inv && !inv.revoked) {
          if (inv.user_id === targetId) return true;
          if (inv.kind === 'workspace' && inv.workspace_id && db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(inv.workspace_id, targetId)) return true;
        }
      } catch { /* invalid invite does not grant visibility */ }
    }
    return false;
  };
  const notWrapped = (w: any) => { if (w.wrapped_at) throw new HttpError(409, 'WORKSPACE_WRAPPED', 'This production has wrapped and is read-only'); };
  const convMembers = (convId: string) => (db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=?').all(convId) as any[]).map(r => r.user_id as string);

  /** Notify: push if on shift, otherwise hold until shift starts. Never includes plaintext. */
  const notify = async (userId: string, kind: string, title: string, body: string, data: Record<string, unknown>, opts: { respectQuiet?: boolean } = {}) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as any;
    if (!u) return { held: false };
    const respect = opts.respectQuiet !== false;
    if (respect && !isOnShift(u, ctx.clock())) {
      db.prepare('INSERT INTO held_notifications (user_id,kind,conversation_id,title,created_at) VALUES (?,?,?,?,?)')
        .run(userId, kind, (data.conversationId as string) || null, title, ctx.clock());
      return { held: true };
    }
    const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id=?').all(userId) as any[];
    if (tokens.length) await ctx.push.send(tokens.map(t => ({ to: t.token, title, body, data: { kind, ...data }, sound: 'default' as const })));
    return { held: false };
  };

  const serializeMessage = (m: any, viewerId: string) => {
    const p = db.prepare('SELECT nonce, ciphertext FROM message_payloads WHERE message_id=? AND recipient_id=?').get(m.id, viewerId) as any;
    let status: string | undefined, readBy = 0, deliveredTo = 0, recipients = 0;
    if (m.sender_id === viewerId) {
      const rs = db.prepare('SELECT user_id, delivered_at, read_at FROM receipts WHERE message_id=? AND user_id != ?').all(m.id, viewerId) as any[];
      recipients = rs.length; readBy = rs.filter(r => r.read_at).length; deliveredTo = rs.filter(r => r.delivered_at).length;
      status = recipients && readBy === recipients ? 'read' : recipients && deliveredTo === recipients ? 'delivered' : 'sent';
      (m as any)._readByUserIds = rs.filter(r => r.read_at).map(r => r.user_id as string);
    }
    return {
      id: m.id, seq: m.seq, conversationId: m.conversation_id, senderId: m.sender_id, clientId: m.client_id, kind: m.kind,
      createdAt: m.created_at, nonce: p?.nonce ?? null, ciphertext: p?.ciphertext ?? null, status, readBy, deliveredTo, recipients,
      readByUserIds: m.sender_id === viewerId ? ((m as any)._readByUserIds as string[] | undefined) : undefined,
    };
  };

  const serializeConv = (c: any, viewerId: string) => {
    const members = db.prepare(`SELECT u.*, cm.role AS cm_role FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=?`).all(c.id) as any[];
    const memberCount = (db.prepare('SELECT COUNT(*) n FROM conversation_members WHERE conversation_id=?').get(c.id) as any).n;
    const me = db.prepare('SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?').get(c.id, viewerId) as any;
    const last = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1').get(c.id) as any;
    const unread = (db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND seq>? AND sender_id!=?').get(c.id, me?.last_read_seq || 0, viewerId) as any).n;
    const ws = c.workspace_id ? db.prepare('SELECT id,name,initial,wrapped_at FROM workspaces WHERE id=?').get(c.workspace_id) as any : null;
    const lastAnn = c.workspace_id ? db.prepare('SELECT title, created_at FROM announcements WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1').get(c.workspace_id) as any : null;
    return {
      id: c.id, kind: c.kind, title: c.title, workspaceId: c.workspace_id, readonly: !!c.readonly || !!ws?.wrapped_at, createdAt: c.created_at,
      memberCount, myRole: me?.role, lastReadSeq: me?.last_read_seq || 0, unread,
      members: members.map(u => ({ ...publicUser(ctx, u), convRole: u.cm_role })),
      lastMessage: last ? serializeMessage(last, viewerId) : null,
      workspace: ws ? { id: ws.id, name: ws.name, initial: ws.initial, wrapped: !!ws.wrapped_at } : null,
      lastAnnouncement: lastAnn ? { title: lastAnn.title, createdAt: lastAnn.created_at } : null,
      e2eeError: memberCount > E2EE_GROUP_LIMIT ? 'GROUP_TOO_LARGE_FOR_E2EE' : null,
    };
  };

  // ---------- health
  app.get('/health', async () => ({ ok: true, time: ctx.clock(), mlsDirectory: !!ctx.cfg.mlsDirectoryEnabled }));

  // ---------- web admin (plain HTML/JS; no @fastify/static)
  const adminDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../admin');
  const serveAdmin = (file: string, type: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = readFileSync(path.join(adminDir, file), 'utf8');
      return reply.type(type).header('cache-control', 'no-store').send(body);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Admin UI file missing');
    }
  };
  app.get('/admin', serveAdmin('index.html', 'text/html; charset=utf-8'));
  app.get('/admin/', serveAdmin('index.html', 'text/html; charset=utf-8'));
  app.get('/admin/app.js', serveAdmin('app.js', 'text/javascript; charset=utf-8'));

  // ---------- auth
  app.post('/auth/otp/request', async req => {
    const b = z.object({ kind: z.enum(['phone', 'email']), destination: z.string().min(3).max(200) }).parse(req.body);
    const dest = validateDestination(b.kind, b.destination);
    const ih = identifierHash(cfg, b.kind, dest);
    const recent = (db.prepare('SELECT COUNT(*) n FROM otps WHERE identifier_hash=? AND created_at>?').get(ih, ctx.clock() - 10 * 60_000) as any).n;
    if (recent >= 5) throw new HttpError(429, 'RATE_LIMITED', 'Too many codes requested. Try again in 10 minutes.');
    const code = genOtp();
    // Resend invalidates any earlier unused codes so only the newest one works.
    db.prepare('UPDATE otps SET used=1 WHERE identifier_hash=? AND used=0').run(ih);
    db.prepare('INSERT INTO otps (identifier_hash,code_hash,expires_at,created_at) VALUES (?,?,?,?)').run(ih, sha256(ih + code), ctx.clock() + cfg.otpTtlSec * 1000, ctx.clock());
    await ctx.otp.send(b.kind, dest, code);
    return { ok: true, expiresInSec: cfg.otpTtlSec, ...(cfg.devReturnOtp ? { devCode: code } : {}) };
  });

  app.post('/auth/otp/verify', async req => {
    const b = z.object({ kind: z.enum(['phone', 'email']), destination: z.string(), code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits') }).parse(req.body);
    const dest = validateDestination(b.kind, b.destination);
    const ih = identifierHash(cfg, b.kind, dest);
    const o = db.prepare('SELECT * FROM otps WHERE identifier_hash=? AND used=0 ORDER BY id DESC LIMIT 1').get(ih) as any;
    if (!o) throw new HttpError(400, 'CODE_NOT_FOUND', 'No active code for this number. Request a new one.');
    if (o.expires_at < ctx.clock()) throw new HttpError(400, 'CODE_EXPIRED', 'That code has expired. Request a new one.');
    if (o.attempts >= 5) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Request a new code.');
    if (o.code_hash !== sha256(ih + b.code)) {
      db.prepare('UPDATE otps SET attempts=attempts+1 WHERE id=?').run(o.id);
      throw new HttpError(400, 'CODE_INCORRECT', 'That code is not right. Check and try again.');
    }
    db.prepare('UPDATE otps SET used=1 WHERE id=?').run(o.id);
    let u = db.prepare('SELECT * FROM users WHERE identifier_hash=?').get(ih) as any;
    const isNew = !u;
    if (!u) {
      const id = uid('u_');
      db.prepare('INSERT INTO users (id, identifier_hash, identifier_kind, created_at) VALUES (?,?,?,?)').run(id, ih, b.kind, ctx.clock());
      u = getUser(id);
    }
    if (u.suspended_until && u.suspended_until > ctx.clock()) throw new HttpError(403, 'SUSPENDED', 'This account is suspended');
    return { ...issueSession(db, cfg, u.id), user: selfUser(ctx, u), isNew };
  });

  app.post('/auth/refresh', async req => {
    const b = z.object({ refreshToken: z.string() }).parse(req.body);
    return rotateRefresh(db, cfg, b.refreshToken);
  });

  app.post('/auth/logout', { preHandler: auth }, async req => {
    const b = z.object({ refreshToken: z.string().optional(), pushToken: z.string().optional() }).parse(req.body || {});
    const sid = b.refreshToken?.split('.')[0];
    if (sid) db.prepare('UPDATE sessions SET revoked=1 WHERE id=? AND user_id=?').run(sid, req.userId);
    if (b.pushToken) db.prepare('DELETE FROM push_tokens WHERE token=? AND user_id=?').run(b.pushToken, req.userId);
    return { ok: true };
  });

  // ---------- me / users
  app.get('/me', { preHandler: auth }, async req => selfUser(ctx, getUser(req.userId)));

  const usernameRe = /^[a-z0-9._]{3,24}$/;
  app.patch('/me', { preHandler: auth }, async req => {
    const b = z.object({
      displayName: z.string().trim().min(1).max(60).optional(),
      username: z.string().trim().toLowerCase().regex(usernameRe, '3–24 characters: letters, numbers, dot, underscore').optional(),
      role: z.string().max(60).optional(), department: z.string().max(60).optional(),
      avatar: z.string().max(400_000).nullable().optional(),
      timezone: z.string().refine(tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone').optional(),
      followPhoneTz: z.boolean().optional(), touringMode: z.boolean().optional(), quietHours: z.boolean().optional(), workMode: z.boolean().optional(),
      workDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      shiftStart: z.string().regex(/^\d\d:\d\d$/).optional(), shiftEnd: z.string().regex(/^\d\d:\d\d$/).optional(),
    }).parse(req.body);
    if (b.username) {
      const taken = db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(b.username, req.userId);
      if (taken) throw new HttpError(409, 'USERNAME_TAKEN', `@${b.username} is taken`);
    }
    const map: Record<string, [string, (v: any) => any]> = {
      displayName: ['display_name', v => v], username: ['username', v => v], role: ['role', v => v], department: ['department', v => v],
      avatar: ['avatar', v => v], timezone: ['timezone', v => v], followPhoneTz: ['follow_phone_tz', v => (v ? 1 : 0)],
      touringMode: ['touring_mode', v => (v ? 1 : 0)], quietHours: ['quiet_hours', v => (v ? 1 : 0)], workMode: ['work_mode', v => (v ? 1 : 0)],
      workDays: ['work_days', v => JSON.stringify(v)], shiftStart: ['shift_start', v => v], shiftEnd: ['shift_end', v => v],
    };
    const prevTz = getUser(req.userId).timezone;
    for (const [k, v] of Object.entries(b)) if (v !== undefined) db.prepare(`UPDATE users SET ${map[k][0]}=? WHERE id=?`).run(map[k][1](v), req.userId);
    const u = getUser(req.userId);
    return { ...selfUser(ctx, u), timezoneChanged: prevTz !== u.timezone ? { from: prevTz, to: u.timezone } : null };
  });

  app.put('/me/keys', { preHandler: auth }, async req => {
    const b = z.object({ identityKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'X25519 public key, base64') }).parse(req.body);
    const prev = getUser(req.userId).identity_key;
    db.prepare('UPDATE users SET identity_key=?, key_updated_at=? WHERE id=?').run(b.identityKey, ctx.clock(), req.userId);
    if (prev && prev !== b.identityKey) {
      // safety number changed — reset verification other people hold for this user
      db.prepare('UPDATE contacts SET verified=0 WHERE contact_id=?').run(req.userId);
      for (const r of db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(req.userId) as any[]) ctx.emit.toUser(r.owner_id, 'keys:changed', { userId: req.userId });
    }
    return { ok: true, changed: !!prev && prev !== b.identityKey };
  });

  app.get('/users/check-username', { preHandler: auth }, async req => {
    const q = z.object({ username: z.string() }).parse(req.query);
    const u = q.username.trim().toLowerCase().replace(/^@/, '');
    if (!usernameRe.test(u)) return { available: false, reason: '3–24 characters: letters, numbers, dot, underscore' };
    const taken = db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(u, req.userId);
    return { available: !taken, reason: taken ? `@${u} is taken` : null };
  });

  app.get('/users/search', { preHandler: auth }, async req => {
    rateLimit(req.userId, 'search', 30, 60_000);
    const q = z.object({ q: z.string() }).parse(req.query).q.trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return { results: [] };
    const like = q.replace(/[%_]/g, '') + '%';
    const rows = db.prepare(`SELECT * FROM users WHERE id!=? AND username IS NOT NULL AND (username LIKE ? OR lower(display_name) LIKE ? OR lower(display_name) LIKE ?)
      AND id NOT IN (SELECT blocked_id FROM blocks WHERE owner_id=?) AND id NOT IN (SELECT owner_id FROM blocks WHERE blocked_id=?) ORDER BY username LIMIT 20`)
      .all(req.userId, like, like, '% ' + like, req.userId, req.userId) as any[];
    const contacts = new Set((db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(req.userId) as any[]).map(r => r.contact_id));
    return { results: rows.map(u => ({ ...publicUser(ctx, u), isContact: contacts.has(u.id) })) };
  });

  app.get('/users/:id', { preHandler: auth }, async req => {
    const { id } = req.params as { id: string };
    const q = z.object({ inviteToken: z.string().optional(), invite: z.string().optional() }).parse(req.query);
    const u = getUser(id);
    if (!canViewUser(req.userId, id, q.inviteToken || q.invite)) throw new HttpError(404, 'USER_NOT_FOUND');
    const c = db.prepare('SELECT verified FROM contacts WHERE owner_id=? AND contact_id=?').get(req.userId, id) as any;
    return { ...publicUser(ctx, u), isContact: !!c, verified: !!c?.verified, blocked: !!db.prepare('SELECT 1 FROM blocks WHERE owner_id=? AND blocked_id=?').get(req.userId, id) };
  });

  // ---------- contacts
  const addContact = (owner: string, other: string) => {
    if (owner === other) throw new HttpError(400, 'SELF_CONTACT', "That's your own code");
    getUser(other);
    if (isBlocked(owner, other)) throw new HttpError(403, 'BLOCKED');
    const t = ctx.clock();
    db.prepare('INSERT OR IGNORE INTO contacts (owner_id,contact_id,created_at) VALUES (?,?,?)').run(owner, other, t);
    db.prepare('INSERT OR IGNORE INTO contacts (owner_id,contact_id,created_at) VALUES (?,?,?)').run(other, owner, t);
    ctx.emit.toUser(other, 'contact:added', { userId: owner });
    return publicUser(ctx, getUser(other));
  };
  app.get('/contacts', { preHandler: auth }, async req => {
    const rows = db.prepare('SELECT u.*, c.verified FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.owner_id=? ORDER BY u.display_name').all(req.userId) as any[];
    return { contacts: rows.map(u => ({ ...publicUser(ctx, u), verified: !!u.verified })) };
  });
  app.post('/contacts', { preHandler: auth }, async req => {
    const b = z.object({ userId: z.string().optional(), inviteToken: z.string().optional() }).parse(req.body);
    let other = b.userId;
    if (b.inviteToken) {
      const p = verifyInvite(cfg, b.inviteToken, ctx.clock());
      const inv = db.prepare('SELECT * FROM invites WHERE id=?').get(p.id) as any;
      if (!inv || inv.revoked) throw new HttpError(400, 'INVITE_INVALID', 'This invite was revoked');
      if (inv.kind !== 'contact') throw new HttpError(400, 'INVITE_INVALID');
      other = inv.user_id;
    }
    if (!other) throw new HttpError(400, 'VALIDATION');
    return { contact: addContact(req.userId, other) };
  });
  app.post('/contacts/:id/verify', { preHandler: auth }, async req => {
    const { id } = req.params as { id: string };
    const b = z.object({ verified: z.boolean().default(true) }).parse(req.body || {});
    const r = db.prepare('UPDATE contacts SET verified=? WHERE owner_id=? AND contact_id=?').run(b.verified ? 1 : 0, req.userId, id);
    if (!r.changes) throw new HttpError(404, 'NOT_A_CONTACT');
    return { ok: true, verified: b.verified };
  });
  app.delete('/contacts/:id', { preHandler: auth }, async req => {
    db.prepare('DELETE FROM contacts WHERE owner_id=? AND contact_id=?').run(req.userId, (req.params as any).id);
    return { ok: true };
  });

  // ---------- invites (QR)
  const mintInvite = (userId: string, kind: 'contact' | 'workspace', workspaceId: string | undefined, ttlSec: number) => {
    if (kind === 'workspace') { if (!workspaceId) throw new HttpError(400, 'VALIDATION'); wsAdmin(workspaceId, userId); notWrapped(getWs(workspaceId)); }
    const id = uid('i_'), exp = ctx.clock() + ttlSec * 1000;
    db.prepare('INSERT INTO invites (id,kind,user_id,workspace_id,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(id, kind, userId, workspaceId || null, exp, ctx.clock());
    const token = signInvite(cfg, { id, k: kind, exp });
    return { id, token, url: `understage://invite/${token}`, expiresAt: exp };
  };
  app.post('/invites', { preHandler: auth }, async req => {
    rateLimit(req.userId, 'invites', 15, 60_000);
    const b = z.object({ kind: z.enum(['contact', 'workspace']).default('contact'), workspaceId: z.string().optional(), ttlSec: z.number().int().min(60).max(30 * 86400).default(7 * 86400) }).parse(req.body || {});
    return mintInvite(req.userId, b.kind, b.workspaceId, b.ttlSec);
  });
  app.post('/invites/regenerate', { preHandler: auth }, async req => {
    rateLimit(req.userId, 'invites', 15, 60_000);
    const b = z.object({ kind: z.enum(['contact', 'workspace']).default('contact'), workspaceId: z.string().optional(), ttlSec: z.number().int().min(60).max(30 * 86400).default(7 * 86400) }).parse(req.body || {});
    if (b.kind === 'workspace') {
      if (!b.workspaceId) throw new HttpError(400, 'VALIDATION');
      db.prepare('UPDATE invites SET revoked=1 WHERE user_id=? AND kind=? AND workspace_id=? AND revoked=0').run(req.userId, 'workspace', b.workspaceId);
    } else {
      db.prepare('UPDATE invites SET revoked=1 WHERE user_id=? AND kind=? AND revoked=0').run(req.userId, 'contact');
    }
    return mintInvite(req.userId, b.kind, b.workspaceId, b.ttlSec);
  });
  const resolveInvite = (token: string) => {
    const p = verifyInvite(cfg, token, ctx.clock());
    const inv = db.prepare('SELECT * FROM invites WHERE id=?').get(p.id) as any;
    if (!inv || inv.revoked) throw new HttpError(400, 'INVITE_INVALID', 'This invite was revoked');
    return inv;
  };
  app.post('/invites/resolve', { preHandler: auth }, async req => {
    const b = z.object({ token: z.string() }).parse(req.body);
    const inv = resolveInvite(b.token);
    const user = publicUser(ctx, getUser(inv.user_id));
    const ws = inv.workspace_id ? getWs(inv.workspace_id) : null;
    return { kind: inv.kind, user, self: inv.user_id === req.userId, workspace: ws ? { id: ws.id, name: ws.name, initial: ws.initial, memberCount: (db.prepare('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?').get(ws.id) as any).n } : null, expiresAt: inv.expires_at };
  });
  app.post('/invites/accept', { preHandler: auth }, async req => {
    const b = z.object({ token: z.string() }).parse(req.body);
    const inv = resolveInvite(b.token);
    if (inv.kind === 'contact') {
      const alreadyContact = !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(req.userId, inv.user_id);
      return { kind: 'contact', contact: addContact(req.userId, inv.user_id), alreadyContact };
    }
    const ws = getWs(inv.workspace_id); notWrapped(ws);
    if (db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ws.id, req.userId)) {
      return { kind: 'workspace', workspaceId: ws.id, alreadyMember: true };
    }
    const count = (db.prepare('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?').get(ws.id) as any).n;
    if (count >= ws.seat_limit) throw new HttpError(409, 'WORKSPACE_FULL', 'This workspace has no seats left');
    joinWorkspace(ws.id, req.userId, 'member', null);
    return { kind: 'workspace', workspaceId: ws.id, alreadyMember: false };
  });

  // ---------- blocks & reports
  app.get('/blocks', { preHandler: auth }, async req => ({ blocked: (db.prepare('SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.owner_id=?').all(req.userId) as any[]).map(u => publicUser(ctx, u)) }));
  app.post('/blocks/:id', { preHandler: auth }, async req => { const id = (req.params as any).id; getUser(id); db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?,?)').run(req.userId, id, ctx.clock()); return { ok: true }; });
  app.delete('/blocks/:id', { preHandler: auth }, async req => { db.prepare('DELETE FROM blocks WHERE owner_id=? AND blocked_id=?').run(req.userId, (req.params as any).id); return { ok: true }; });
  app.post('/reports', { preHandler: auth }, async req => {
    rateLimit(req.userId, 'reports', 8, 60_000);
    const b = z.object({ reportedId: z.string(), reason: z.enum(['harassment', 'spam', 'impersonation', 'other']), evidence: z.array(z.object({ text: z.string().max(4000), at: z.number() })).max(50).default([]), alsoBlock: z.boolean().default(false), note: z.string().max(2000).optional() }).parse(req.body);
    getUser(b.reportedId);
    const number = 2000 + ((db.prepare('SELECT COUNT(*) n FROM reports').get() as any).n as number) + 1;
    const id = uid('r_');
    db.prepare('INSERT INTO reports (id,number,reporter_id,reported_id,reason,evidence,also_blocked,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, number, req.userId, b.reportedId, b.reason, JSON.stringify(b.evidence), b.alsoBlock ? 1 : 0, ctx.clock());
    if (b.alsoBlock) db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?,?)').run(req.userId, b.reportedId, ctx.clock());
    return { id, number: `R-${number}`, blocked: b.alsoBlock };
  });

  // ---------- conversations
  const createConv = (kind: string, creator: string, memberIds: string[], title: string | null, workspaceId: string | null = null) => {
    const id = uid('c_');
    db.prepare('INSERT INTO conversations (id,kind,title,workspace_id,created_by,created_at) VALUES (?,?,?,?,?,?)').run(id, kind, title, workspaceId, creator, ctx.clock());
    const ins = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)');
    const tx = db.transaction(() => { for (const m of new Set([creator, ...memberIds])) ins.run(id, m, m === creator ? 'admin' : 'member', ctx.clock()); });
    tx();
    return id;
  };
  app.get('/conversations', { preHandler: auth }, async req => {
    const rows = db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE m.user_id=?`).all(req.userId) as any[];
    const list = rows.map(c => serializeConv(c, req.userId));
    list.sort((a, b) => (b.lastMessage?.createdAt || b.lastAnnouncement?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.lastAnnouncement?.createdAt || a.createdAt));
    return { conversations: list };
  });
  app.post('/conversations', { preHandler: auth }, async req => {
    const b = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('direct'), userId: z.string() }),
      z.object({ kind: z.literal('group'), title: z.string().trim().min(1).max(60), memberIds: z.array(z.string()).min(1).max(500) }),
    ]).parse(req.body);
    if (b.kind === 'direct') {
      getUser(b.userId);
      if (b.userId === req.userId) throw new HttpError(400, 'SELF_CHAT');
      if (isBlocked(req.userId, b.userId)) throw new HttpError(403, 'BLOCKED');
      const ex = db.prepare(`SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=? JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=? WHERE c.kind='direct'`).get(req.userId, b.userId) as any;
      const id = ex?.id || createConv('direct', req.userId, [b.userId], null);
      return { conversation: serializeConv(db.prepare('SELECT * FROM conversations WHERE id=?').get(id), req.userId) };
    }
    for (const m of b.memberIds) getUser(m);
    const unique = [...new Set([req.userId, ...b.memberIds])];
    if (unique.length > E2EE_GROUP_LIMIT) throw new HttpError(409, 'GROUP_TOO_LARGE_FOR_E2EE', `Encrypted groups are limited to ${E2EE_GROUP_LIMIT} members`);
    const id = createConv('group', req.userId, b.memberIds, b.title);
    for (const m of b.memberIds) ctx.emit.toUser(m, 'conversation:updated', { conversationId: id });
    return { conversation: serializeConv(db.prepare('SELECT * FROM conversations WHERE id=?').get(id), req.userId) };
  });
  app.get('/conversations/:id', { preHandler: auth }, async req => {
    const id = (req.params as any).id; memberOf(id, req.userId);
    return { conversation: serializeConv(db.prepare('SELECT * FROM conversations WHERE id=?').get(id), req.userId) };
  });
  const convAdmin = (id: string, userId: string) => { const m = memberOf(id, userId); if (m.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Only group admins can do this'); };
  app.patch('/conversations/:id', { preHandler: auth }, async req => {
    const id = (req.params as any).id; convAdmin(id, req.userId);
    const b = z.object({ title: z.string().trim().min(1).max(60) }).parse(req.body);
    db.prepare('UPDATE conversations SET title=? WHERE id=?').run(b.title, id);
    for (const m of convMembers(id)) ctx.emit.toUser(m, 'conversation:updated', { conversationId: id });
    return { ok: true };
  });
  app.post('/conversations/:id/members', { preHandler: auth }, async req => {
    const id = (req.params as any).id; convAdmin(id, req.userId);
    const c = db.prepare('SELECT kind FROM conversations WHERE id=?').get(id) as any;
    if (c.kind !== 'group') throw new HttpError(400, 'NOT_A_GROUP');
    const b = z.object({ userIds: z.array(z.string()).min(1) }).parse(req.body);
    const already = new Set((db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=?').all(id) as any[]).map(r => r.user_id as string));
    const adding = [...new Set(b.userIds)].filter(u => !already.has(u));
    if (already.size + adding.length > E2EE_GROUP_LIMIT) throw new HttpError(409, 'GROUP_TOO_LARGE_FOR_E2EE', `Encrypted groups are limited to ${E2EE_GROUP_LIMIT} members`);
    for (const u of b.userIds) { getUser(u); db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(id, u, 'member', ctx.clock()); }
    for (const m of convMembers(id)) ctx.emit.toUser(m, 'conversation:updated', { conversationId: id });
    return { ok: true, conversation: serializeConv(db.prepare('SELECT * FROM conversations WHERE id=?').get(id), req.userId) };
  });
  app.patch('/conversations/:id/members/:uid', { preHandler: auth }, async req => {
    const { id, uid: target } = req.params as any; convAdmin(id, req.userId); memberOf(id, target);
    const b = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);
    db.prepare('UPDATE conversation_members SET role=? WHERE conversation_id=? AND user_id=?').run(b.role, id, target);
    writeAudit(req.userId, 'conversation.role_change', 'conversation_member', target, { conversationId: id, role: b.role });
    return { ok: true };
  });
  app.delete('/conversations/:id/members/:uid', { preHandler: auth }, async req => {
    const { id, uid: target } = req.params as any;
    if (target !== req.userId) convAdmin(id, req.userId); else memberOf(id, req.userId);
    db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?').run(id, target);
    for (const m of [...convMembers(id), target]) ctx.emit.toUser(m, 'conversation:updated', { conversationId: id });
    return { ok: true };
  });

  // ---------- messages (ciphertext only)
  app.get('/conversations/:id/messages', { preHandler: auth }, async req => {
    const id = (req.params as any).id; memberOf(id, req.userId);
    const q = z.object({ before: z.coerce.number().optional(), after: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    let rows: any[];
    if (q.after !== undefined) rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq ASC LIMIT ?').all(id, q.after, q.limit) as any[];
    else rows = (db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, q.before ?? Number.MAX_SAFE_INTEGER, q.limit) as any[]).reverse();
    return { messages: rows.map(m => serializeMessage(m, req.userId)) };
  });

  app.post('/conversations/:id/messages', { preHandler: auth }, async req => {
    const id = (req.params as any).id; memberOf(id, req.userId);
    rateLimit(req.userId, 'messages', 40, 60_000);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as any;
    if (conv.readonly) throw new HttpError(409, 'READ_ONLY', 'This chat is read-only');
    if (conv.workspace_id) notWrapped(getWs(conv.workspace_id));
    const b = z.object({
      clientId: z.string().min(8).max(64),
      payloads: z.array(z.object({ recipientId: z.string(), nonce: z.string().max(64), ciphertext: z.string().max(200_000) })).min(1),
    }).parse(req.body);
    const existing = db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(req.userId, b.clientId) as any;
    if (existing) return { message: serializeMessage(existing, req.userId), duplicate: true }; // idempotent outbox retry
    const members = convMembers(id);
    if (conv.kind !== 'direct' && members.length > E2EE_GROUP_LIMIT) {
      throw new HttpError(409, 'GROUP_TOO_LARGE_FOR_E2EE', `This conversation has ${members.length} members, which exceeds the ${E2EE_GROUP_LIMIT}-person limit for end-to-end encrypted chat.`);
    }
    if (conv.kind === 'direct') { const other = members.find(m => m !== req.userId)!; if (isBlocked(req.userId, other)) throw new HttpError(403, 'BLOCKED', 'You can’t message this person'); }
    const given = new Set(b.payloads.map(p => p.recipientId));
    const missing = members.filter(m => !given.has(m));
    if (missing.length) throw new HttpError(409, 'MISSING_RECIPIENTS', `Encrypt for all members: ${missing.join(',')}`);
    const mid = uid('m_');
    const t = ctx.clock();
    db.transaction(() => {
      db.prepare('INSERT INTO messages (id,conversation_id,sender_id,client_id,created_at) VALUES (?,?,?,?,?)').run(mid, id, req.userId, b.clientId, t);
      const ip = db.prepare('INSERT INTO message_payloads VALUES (?,?,?,?)');
      const ir = db.prepare('INSERT INTO receipts (message_id,user_id) VALUES (?,?)');
      for (const p of b.payloads) if (members.includes(p.recipientId)) { ip.run(mid, p.recipientId, p.nonce, p.ciphertext); if (p.recipientId !== req.userId) ir.run(mid, p.recipientId); }
    })();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(mid) as any;
    db.prepare('UPDATE conversations SET last_seq=? WHERE id=?').run(row.seq, id);
    db.prepare('UPDATE conversation_members SET last_read_seq=? WHERE conversation_id=? AND user_id=?').run(row.seq, id, req.userId);
    const sender = getUser(req.userId);
    for (const m of members) {
      ctx.emit.toUser(m, 'message:new', serializeMessage(row, m));
      if (m !== req.userId) await notify(m, 'message', conv.kind === 'group' ? conv.title : sender.display_name, 'New encrypted message', { conversationId: id, messageId: mid });
    }
    return { message: serializeMessage(row, req.userId) };
  });

  const markReceipts = (userId: string, ids: string[], field: 'delivered_at' | 'read_at') => {
    const t = ctx.clock();
    const touched: any[] = [];
    for (const mid of ids) {
      const r = db.prepare(`UPDATE receipts SET ${field}=COALESCE(${field}, ?)${field === 'read_at' ? ', delivered_at=COALESCE(delivered_at, ?)' : ''} WHERE message_id=? AND user_id=?`)
        .run(...(field === 'read_at' ? [t, t, mid, userId] : [t, mid, userId]));
      if (r.changes) touched.push(db.prepare('SELECT * FROM messages WHERE id=?').get(mid));
    }
    for (const m of touched) ctx.emit.toUser(m.sender_id, 'message:status', serializeMessage(m, m.sender_id));
    return touched.length;
  };
  app.post('/messages/delivered', { preHandler: auth }, async req => {
    const b = z.object({ messageIds: z.array(z.string()).max(500) }).parse(req.body);
    return { updated: markReceipts(req.userId, b.messageIds, 'delivered_at') };
  });
  app.post('/conversations/:id/read', { preHandler: auth }, async req => {
    const id = (req.params as any).id; memberOf(id, req.userId);
    const b = z.object({ seq: z.number().int() }).parse(req.body);
    db.prepare('UPDATE conversation_members SET last_read_seq=MAX(last_read_seq, ?) WHERE conversation_id=? AND user_id=?').run(b.seq, id, req.userId);
    const ids = (db.prepare('SELECT m.id FROM messages m JOIN receipts r ON r.message_id=m.id AND r.user_id=? WHERE m.conversation_id=? AND m.seq<=? AND r.read_at IS NULL').all(req.userId, id, b.seq) as any[]).map(r => r.id);
    return { updated: markReceipts(req.userId, ids, 'read_at') };
  });
  app.get('/sync', { preHandler: auth }, async req => {
    const q = z.object({ since: z.coerce.number().default(0), limit: z.coerce.number().max(1000).default(500) }).parse(req.query);
    const rows = db.prepare(`SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? WHERE m.seq>? ORDER BY m.seq ASC LIMIT ?`).all(req.userId, q.since, q.limit) as any[];
    return { messages: rows.map(m => serializeMessage(m, req.userId)), cursor: rows.length ? rows[rows.length - 1].seq : q.since };
  });

  // ---------- attachments (client-side encrypted blobs)
  app.post('/attachments', { preHandler: auth }, async req => {
    rateLimit(req.userId, 'attachments', 20, 60_000);
    const b = z.object({ conversationId: z.string(), data: z.string().min(1) }).parse(req.body);
    memberOf(b.conversationId, req.userId);
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE', 'Attachments are limited to 25 MB');
    const id = uid('a_');
    db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(id, req.userId, b.conversationId, buf.length, buf, ctx.clock());
    return { id, size: buf.length };
  });
  app.get('/attachments/:id', { preHandler: auth }, async req => {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get((req.params as any).id) as any;
    if (!a) throw new HttpError(404, 'NOT_FOUND');
    memberOf(a.conversation_id, req.userId);
    return { id: a.id, data: Buffer.from(a.data).toString('base64') };
  });

  // ---------- workspaces
  const joinWorkspace = (wsId: string, userId: string, role: string, deptId: string | null, city = '') => {
    db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role,department_id,city,joined_at) VALUES (?,?,?,?,?,?)').run(wsId, userId, role, deptId, city, ctx.clock());
    const conv = db.prepare("SELECT id FROM conversations WHERE workspace_id=? AND kind='workspace'").get(wsId) as any;
    if (conv) db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(conv.id, userId, role === 'member' ? 'member' : 'admin', ctx.clock());
  };
  (app as any).joinWorkspace = joinWorkspace;
  const serializeWs = (w: any, viewer: string) => {
    const me = db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(w.id, viewer) as any;
    const memberCount = (db.prepare('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?').get(w.id) as any).n;
    const depts = db.prepare('SELECT d.id, d.name, (SELECT COUNT(*) FROM workspace_members m WHERE m.department_id=d.id) AS count FROM departments d WHERE d.workspace_id=? ORDER BY d.sort').all(w.id) as any[];
    const admins = (db.prepare("SELECT u.display_name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role IN ('owner','admin') ORDER BY m.joined_at").all(w.id) as any[]).map(r => r.display_name);
    const conv = db.prepare("SELECT id FROM conversations WHERE workspace_id=? AND kind='workspace'").get(w.id) as any;
    return { id: w.id, name: w.name, initial: w.initial, venue: w.venue, runLabel: w.run_label, seatLimit: w.seat_limit, plan: w.plan, memberCount, departments: depts, admins, myRole: me?.role, wrappedAt: w.wrapped_at, deleteAfter: w.delete_after, conversationId: conv?.id ?? null };
  };
  app.get('/workspaces', { preHandler: auth }, async req => ({ workspaces: (db.prepare('SELECT w.* FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=?').all(req.userId) as any[]).map(w => serializeWs(w, req.userId)) }));
  app.post('/workspaces', { preHandler: auth }, async req => {
    const b = z.object({ name: z.string().trim().min(2).max(80), venue: z.string().max(80).default(''), runLabel: z.string().max(80).default(''), departments: z.array(z.string().min(1).max(40)).max(30).default([]), seatLimit: z.number().int().min(2).max(200).optional() }).parse(req.body);
    const entitled = entitledPlan(req.userId);
    if (entitled.seats <= 0) throw new HttpError(403, 'PLAN_REQUIRED', 'Upgrade to Production or Company to create a workspace');
    const seatLimit = Math.min(b.seatLimit ?? entitled.seats, entitled.seats);
    const id = uid('w_');
    db.prepare('INSERT INTO workspaces (id,name,initial,venue,run_label,seat_limit,plan,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, b.name, b.name[0].toUpperCase(), b.venue, b.runLabel, seatLimit, entitled.id, req.userId, ctx.clock());
    b.departments.forEach((d, i) => db.prepare('INSERT INTO departments VALUES (?,?,?,?)').run(uid('d_'), id, d, i));
    const convId = uid('c_');
    db.prepare("INSERT INTO conversations (id,kind,title,workspace_id,created_by,created_at) VALUES (?,'workspace',?,?,?,?)").run(convId, b.name, id, req.userId, ctx.clock());
    joinWorkspace(id, req.userId, 'owner', null);
    return { workspace: serializeWs(getWs(id), req.userId) };
  });
  app.get('/workspaces/:id', { preHandler: auth }, async req => { const id = (req.params as any).id; wsMember(id, req.userId); return { workspace: serializeWs(getWs(id), req.userId) }; });
  app.get('/workspaces/:id/members', { preHandler: auth }, async req => {
    const id = (req.params as any).id; wsMember(id, req.userId);
    const q = z.object({ q: z.string().optional(), departmentId: z.string().optional(), offset: z.coerce.number().default(0), limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    let sql = 'SELECT u.*, m.role AS ws_role, m.department_id, m.city, d.name AS dept_name FROM workspace_members m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id WHERE m.workspace_id=?';
    const args: any[] = [id];
    if (q.departmentId) { sql += ' AND m.department_id=?'; args.push(q.departmentId); }
    if (q.q) { const like = `%${escapeLike(q.q.toLowerCase())}%`; sql += " AND (lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(u.username) LIKE ? ESCAPE '\\')"; args.push(like, like); }
    const total = (db.prepare(sql.replace(/^SELECT .* FROM workspace_members/, 'SELECT COUNT(*) n FROM workspace_members')).get(...args) as any).n;
    sql += " ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name LIMIT ? OFFSET ?"; args.push(q.limit, q.offset);
    const rows = db.prepare(sql).all(...args) as any[];
    return { total, members: rows.map(u => ({ ...publicUser(ctx, u), wsRole: u.ws_role, departmentId: u.department_id, departmentName: u.dept_name, city: u.city })) };
  });
  app.patch('/workspaces/:id/members/:uid', { preHandler: auth }, async req => {
    const { id, uid: target } = req.params as any; wsAdmin(id, req.userId); wsMember(id, target);
    const b = z.object({ role: z.enum(['admin', 'member']).optional(), departmentId: z.string().nullable().optional() }).parse(req.body);
    if (b.role) {
      db.prepare("UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=? AND role!='owner'").run(b.role, id, target);
      writeAudit(req.userId, 'workspace.role_change', 'workspace_member', target, { workspaceId: id, role: b.role });
    }
    if (b.departmentId !== undefined) db.prepare('UPDATE workspace_members SET department_id=? WHERE workspace_id=? AND user_id=?').run(b.departmentId, id, target);
    return { ok: true };
  });
  app.delete('/workspaces/:id/members/:uid', { preHandler: auth }, async req => {
    const { id, uid: target } = req.params as any; if (target !== req.userId) wsAdmin(id, req.userId);
    db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=? AND role!='owner'").run(id, target);
    const conv = db.prepare("SELECT id FROM conversations WHERE workspace_id=? AND kind='workspace'").get(id) as any;
    if (conv) db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?').run(conv.id, target);
    return { ok: true };
  });

  // ---------- announcements
  const annStats = (a: any) => {
    const r = db.prepare('SELECT COUNT(*) total, SUM(acked_at IS NOT NULL) acked, SUM(seen_at IS NOT NULL AND acked_at IS NULL) seen FROM announcement_recipients WHERE announcement_id=?').get(a.id) as any;
    return { total: r.total || 0, acked: r.acked || 0, seenNotAcked: r.seen || 0 };
  };
  const serializeAnn = (a: any, viewer: string) => {
    const me = db.prepare('SELECT * FROM announcement_recipients WHERE announcement_id=? AND user_id=?').get(a.id, viewer) as any;
    const author = db.prepare('SELECT display_name FROM users WHERE id=?').get(a.author_id) as any;
    return { id: a.id, workspaceId: a.workspace_id, authorId: a.author_id, authorName: author?.display_name, title: a.title, body: a.body, requireAck: !!a.require_ack, respectQuietHours: !!a.respect_quiet, departmentIds: a.department_ids ? JSON.parse(a.department_ids) : null, createdAt: a.created_at, mine: a.author_id === viewer, myAckAt: me?.acked_at ?? null, ...annStats(a) };
  };
  app.get('/workspaces/:id/announcements', { preHandler: auth }, async req => {
    const id = (req.params as any).id; wsMember(id, req.userId);
    const rows = db.prepare('SELECT a.* FROM announcements a WHERE a.workspace_id=? AND (a.author_id=? OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id=a.id AND r.user_id=?)) ORDER BY a.created_at DESC').all(id, req.userId, req.userId) as any[];
    return { announcements: rows.map(a => serializeAnn(a, req.userId)) };
  });
  app.post('/workspaces/:id/announcements', { preHandler: auth }, async req => {
    const id = (req.params as any).id; wsAdmin(id, req.userId); const ws = getWs(id); notWrapped(ws);
    const b = z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(4000), requireAck: z.boolean().default(false), respectQuietHours: z.boolean().default(true), departmentIds: z.array(z.string()).nullable().default(null) }).parse(req.body);
    const aid = uid('n_');
    db.prepare('INSERT INTO announcements (id,workspace_id,author_id,title,body,require_ack,respect_quiet,department_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(aid, id, req.userId, b.title, b.body, b.requireAck ? 1 : 0, b.respectQuietHours ? 1 : 0, b.departmentIds?.length ? JSON.stringify(b.departmentIds) : null, ctx.clock());
    let recips = (db.prepare('SELECT user_id, department_id FROM workspace_members WHERE workspace_id=? AND user_id!=?').all(id, req.userId) as any[]);
    if (b.departmentIds?.length) recips = recips.filter(r => b.departmentIds!.includes(r.department_id));
    const ins = db.prepare('INSERT INTO announcement_recipients (announcement_id,user_id) VALUES (?,?)');
    db.transaction(() => { for (const r of recips) ins.run(aid, r.user_id); })();
    let held = 0;
    for (const r of recips) {
      ctx.emit.toUser(r.user_id, 'announcement:new', { workspaceId: id, announcementId: aid });
      if ((await notify(r.user_id, 'announcement', `📣 ${ws.name}`, b.title, { workspaceId: id, announcementId: aid }, { respectQuiet: b.respectQuietHours })).held) held++;
    }
    return { announcement: serializeAnn(db.prepare('SELECT * FROM announcements WHERE id=?').get(aid), req.userId), recipients: recips.length, held };
  });
  const getAnn = (id: string) => { const a = db.prepare('SELECT * FROM announcements WHERE id=?').get(id) as any; if (!a) throw new HttpError(404, 'NOT_FOUND'); return a; };
  app.post('/announcements/:id/seen', { preHandler: auth }, async req => {
    const a = getAnn((req.params as any).id);
    db.prepare('UPDATE announcement_recipients SET seen_at=COALESCE(seen_at, ?) WHERE announcement_id=? AND user_id=?').run(ctx.clock(), a.id, req.userId);
    return { ok: true };
  });
  app.post('/announcements/:id/ack', { preHandler: auth }, async req => {
    const a = getAnn((req.params as any).id);
    notWrapped(getWs(a.workspace_id));
    if (!a.require_ack) throw new HttpError(400, 'ACK_NOT_REQUIRED');
    const t = ctx.clock();
    const r = db.prepare('UPDATE announcement_recipients SET acked_at=COALESCE(acked_at, ?), seen_at=COALESCE(seen_at, ?) WHERE announcement_id=? AND user_id=?').run(t, t, a.id, req.userId);
    if (!r.changes) throw new HttpError(403, 'NOT_A_RECIPIENT');
    const stats = annStats(a);
    const admins = db.prepare("SELECT user_id FROM workspace_members WHERE workspace_id=? AND role IN ('owner','admin')").all(a.workspace_id) as any[];
    for (const ad of [...admins.map(x => x.user_id), req.userId]) ctx.emit.toUser(ad, 'announcement:ack', { announcementId: a.id, ...stats });
    return { ok: true, ackedAt: (db.prepare('SELECT acked_at FROM announcement_recipients WHERE announcement_id=? AND user_id=?').get(a.id, req.userId) as any).acked_at, ...stats };
  });
  app.get('/announcements/:id/acks', { preHandler: auth }, async req => {
    const a = getAnn((req.params as any).id); wsAdmin(a.workspace_id, req.userId);
    const rows = db.prepare('SELECT u.*, r.seen_at, r.acked_at, r.reminded_at FROM announcement_recipients r JOIN users u ON u.id=r.user_id WHERE r.announcement_id=? ORDER BY r.acked_at IS NOT NULL, r.seen_at IS NULL, u.display_name').all(a.id) as any[];
    const map = (u: any) => ({ ...publicUser(ctx, u), seenAt: u.seen_at, ackedAt: u.acked_at, remindedAt: u.reminded_at });
    const pending = rows.filter(r => !r.acked_at).map(map), acknowledged = rows.filter(r => r.acked_at).map(map);
    return { announcement: serializeAnn(a, req.userId), pending, acknowledged, offShift: pending.filter(p => !p.onShift && !p.seenAt).length };
  });
  app.post('/announcements/:id/remind', { preHandler: auth }, async req => {
    const a = getAnn((req.params as any).id); wsAdmin(a.workspace_id, req.userId); notWrapped(getWs(a.workspace_id));
    const pending = db.prepare('SELECT user_id FROM announcement_recipients WHERE announcement_id=? AND acked_at IS NULL').all(a.id) as any[];
    let held = 0;
    for (const p of pending) {
      db.prepare('UPDATE announcement_recipients SET reminded_at=? WHERE announcement_id=? AND user_id=?').run(ctx.clock(), a.id, p.user_id);
      if ((await notify(p.user_id, 'reminder', 'Reminder: please acknowledge', a.title, { workspaceId: a.workspace_id, announcementId: a.id }, { respectQuiet: !!a.respect_quiet })).held) held++;
    }
    return { reminded: pending.length, held, deliveredNow: pending.length - held };
  });
  app.post('/workspaces/:id/wrap', { preHandler: auth }, async req => {
    const id = (req.params as any).id; wsAdmin(id, req.userId); const ws = getWs(id); notWrapped(ws);
    const t = ctx.clock();
    db.prepare('UPDATE workspaces SET wrapped_at=?, delete_after=? WHERE id=?').run(t, t + 30 * DAY, id);
    db.prepare('UPDATE conversations SET readonly=1 WHERE workspace_id=?').run(id);
    db.prepare('UPDATE invites SET revoked=1 WHERE workspace_id=?').run(id);
    writeAudit(req.userId, 'workspace.wrap', 'workspace', id, { name: ws.name });
    for (const m of db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id=?').all(id) as any[]) ctx.emit.toUser(m.user_id, 'workspace:wrapped', { workspaceId: id });
    return { workspace: serializeWs(getWs(id), req.userId) };
  });

  // ---------- quiet hours / held notifications
  app.get('/me/held', { preHandler: auth }, async req => {
    const rows = db.prepare('SELECT kind, conversation_id, title, COUNT(*) n, MAX(created_at) last FROM held_notifications WHERE user_id=? AND released_at IS NULL GROUP BY kind, conversation_id, title ORDER BY last DESC').all(req.userId) as any[];
    const u = getUser(req.userId);
    return { onShift: isOnShift(u, ctx.clock()), shiftStart: u.shift_start, count: rows.reduce((s, r) => s + r.n, 0), groups: rows.map(r => ({ kind: r.kind, conversationId: r.conversation_id, title: r.title, count: r.n, last: r.last })) };
  });
  app.post('/me/held/release', { preHandler: auth }, async req => {
    const u = getUser(req.userId);
    if (!isOnShift(u, ctx.clock())) throw new HttpError(409, 'OFF_SHIFT', 'Held messages are released when your shift starts');
    const r = db.prepare('UPDATE held_notifications SET released_at=? WHERE user_id=? AND released_at IS NULL').run(ctx.clock(), req.userId);
    return { released: r.changes };
  });

  // ---------- calls
  app.get('/calls', { preHandler: auth }, async req => {
    const rows = db.prepare('SELECT * FROM calls WHERE caller_id=? OR callee_id=? ORDER BY started_at DESC LIMIT 100').all(req.userId, req.userId) as any[];
    return { calls: rows.map(c => { const otherId = c.caller_id === req.userId ? c.callee_id : c.caller_id; const o = db.prepare('SELECT * FROM users WHERE id=?').get(otherId) as any; return { id: c.id, direction: c.caller_id === req.userId ? 'outgoing' : 'incoming', other: o ? publicUser(ctx, o) : null, status: c.status, startedAt: c.started_at, answeredAt: c.answered_at, endedAt: c.ended_at, endReason: c.end_reason, durationSec: c.answered_at && c.ended_at ? Math.round((c.ended_at - c.answered_at) / 1000) : 0 }; }) };
  });
  app.get('/calls/ice', { preHandler: auth }, async () => ({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, ...(cfg.turnUrls.length ? [{ urls: cfg.turnUrls, username: cfg.turnUsername, credential: cfg.turnCredential }] : [])],
    turnConfigured: cfg.turnUrls.length > 0,
  }));

  // ---------- push tokens
  app.post('/push/tokens', { preHandler: auth }, async req => {
    const b = z.object({ token: z.string().min(10).max(300), platform: z.enum(['ios', 'android']) }).parse(req.body);
    db.prepare('INSERT OR REPLACE INTO push_tokens VALUES (?,?,?,?)').run(b.token, req.userId, b.platform, ctx.clock());
    return { ok: true };
  });

  // ---------- subscriptions
  app.get('/subscriptions/plans', async () => ({ plans: PLANS, trialDays: 14, samplePrices: true }));
  app.get('/subscriptions/me', { preHandler: auth }, async req => {
    const u = getUser(req.userId);
    const ws = db.prepare("SELECT w.* FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND w.wrapped_at IS NULL LIMIT 1").get(req.userId) as any;
    const seats = ws ? (db.prepare('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?').get(ws.id) as any).n : 0;
    const plan = PLANS.find(p => p.id === u.plan) || PLANS[0];
    return { plan, status: u.plan_status, renewsAt: u.plan_renews_at, seatsUsed: seats, seatLimit: plan.seats };
  });
  app.post('/subscriptions/verify', { preHandler: auth }, async req => {
    const b = z.object({
      planId: z.enum(['production', 'company']).optional(),
      transactionId: z.string().optional(),
      signedTransaction: z.string().optional(),
      platform: z.enum(['ios', 'android']).default('ios'),
      dev: z.boolean().optional(),
    }).parse(req.body);
    // Never grant from `dev: true` / SUBSCRIPTIONS_DEV — entitlements require a verified JWS.
    const roots = loadTrustedRootPems();
    if (!iapVerificationReady(roots)) {
      throw new HttpError(501, 'IAP_NOT_CONFIGURED', 'Subscription verification is disabled until Apple root CA certificates are configured (APPLE_ROOT_CA_PEM or APPLE_IAP_ROOTS_DIR). App Store Connect API keys are not required. See docs/PUSH_AND_IAP_REQUIREMENTS.md.');
    }
    if (!b.signedTransaction) {
      throw new HttpError(400, 'IAP_UNVERIFIED', 'A signed App Store transaction JWS is required');
    }
    const verified = verifySignedTransaction(b.signedTransaction, {
      roots,
      now: ctx.clock(),
      expectedBundleId: process.env.APPLE_BUNDLE_ID || 'com.kvmac.understage',
    });
    if (!verified.ok) {
      throw new HttpError(400, 'IAP_UNVERIFIED', verified.error);
    }
    const planId = planFromProductId(verified.transaction.productId);
    if (!planId) throw new HttpError(400, 'IAP_UNVERIFIED', 'Unknown productId');
    if (b.planId && b.planId !== planId) throw new HttpError(400, 'IAP_UNVERIFIED', 'planId does not match the signed transaction');
    if (b.transactionId && b.transactionId !== verified.transaction.transactionId) {
      throw new HttpError(400, 'IAP_UNVERIFIED', 'transactionId does not match the signed transaction');
    }
    const exp = verified.transaction.expiresDate;
    if (typeof exp === 'number' && exp <= ctx.clock()) {
      throw new HttpError(400, 'IAP_EXPIRED', 'Signed transaction is expired');
    }
    const renews = typeof exp === 'number' ? exp : ctx.clock() + 14 * DAY;
    db.prepare("UPDATE users SET plan=?, plan_status='active', plan_renews_at=? WHERE id=?").run(planId, renews, req.userId);
    return { ok: true, planId, status: 'active', renewsAt: renews, environment: verified.transaction.environment || null };
  });

  // ---------- support tickets (user side)
  app.post('/support/tickets', { preHandler: auth }, async req => {
    const b = z.object({ subject: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const id = uid('t_');
    db.prepare('INSERT INTO tickets (id,user_id,subject,created_at) VALUES (?,?,?,?)').run(id, req.userId, b.subject, ctx.clock());
    db.prepare('INSERT INTO ticket_messages (ticket_id,author,body,created_at) VALUES (?,?,?,?)').run(id, 'user', b.body, ctx.clock());
    return { id };
  });
  app.get('/support/tickets', { preHandler: auth }, async req => ({ tickets: db.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC').all(req.userId) }));
  app.get('/support/tickets/:id', { preHandler: auth }, async req => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get((req.params as any).id, req.userId) as any;
    if (!t) throw new HttpError(404, 'NOT_FOUND');
    return { ticket: t, messages: db.prepare('SELECT author, body, created_at AS createdAt FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(t.id) };
  });
  app.post('/support/tickets/:id/messages', { preHandler: auth }, async req => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get((req.params as any).id, req.userId) as any;
    if (!t) throw new HttpError(404, 'NOT_FOUND');
    const b = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    db.prepare('INSERT INTO ticket_messages (ticket_id,author,body,created_at) VALUES (?,?,?,?)').run(t.id, 'user', b.body, ctx.clock());
    return { ok: true };
  });

  // ---------- admin (web dashboard backend)
  app.get('/admin/reports', { preHandler: adminAuth }, async req => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = db.prepare(`SELECT r.*, a.username AS reporter, b.username AS reported FROM reports r JOIN users a ON a.id=r.reporter_id JOIN users b ON b.id=r.reported_id ${q.status ? 'WHERE r.status=?' : ''} ORDER BY r.created_at DESC`).all(...(q.status ? [q.status] : [])) as any[];
    return { reports: rows.map(r => ({ id: r.id, number: `R-${r.number}`, reporter: r.reporter, reported: r.reported, reportedId: r.reported_id, reason: r.reason, evidence: JSON.parse(r.evidence), alsoBlocked: !!r.also_blocked, status: r.status, createdAt: r.created_at })) };
  });
  app.patch('/admin/reports/:id', { preHandler: adminAuth }, async req => {
    const b = z.object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']) }).parse(req.body);
    const r = db.prepare('UPDATE reports SET status=? WHERE id=?').run(b.status, (req.params as any).id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND');
    writeAudit(req.userId, 'admin.report_status', 'report', (req.params as any).id, { status: b.status });
    return { ok: true };
  });
  app.post('/admin/suspensions', { preHandler: adminAuth }, async req => {
    const b = z.object({ userId: z.string(), duration: z.enum(['7d', '30d', 'permanent']), reason: z.string().min(2).max(500) }).parse(req.body);
    getUser(b.userId);
    const until = b.duration === 'permanent' ? 8.64e15 : ctx.clock() + (b.duration === '7d' ? 7 : 30) * DAY;
    const id = uid('x_');
    db.prepare('INSERT INTO suspensions (id,user_id,duration,reason,until,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, b.userId, b.duration, b.reason, until, req.userId, ctx.clock());
    db.prepare('UPDATE users SET suspended_until=?, suspension_reason=? WHERE id=?').run(until, b.reason, b.userId);
    db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(b.userId);
    writeAudit(req.userId, 'admin.suspend', 'user', b.userId, { duration: b.duration, reason: b.reason, until });
    return { id, until };
  });
  app.get('/admin/suspensions', { preHandler: adminAuth }, async () => ({ suspensions: db.prepare('SELECT s.*, u.username, u.display_name FROM suspensions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC').all() }));
  app.delete('/admin/suspensions/:id', { preHandler: adminAuth }, async req => {
    const s = db.prepare('SELECT * FROM suspensions WHERE id=?').get((req.params as any).id) as any;
    if (!s) throw new HttpError(404, 'NOT_FOUND');
    db.prepare('UPDATE suspensions SET lifted=1 WHERE id=?').run(s.id);
    db.prepare('UPDATE users SET suspended_until=NULL, suspension_reason=NULL WHERE id=?').run(s.user_id);
    writeAudit(req.userId, 'admin.unsuspend', 'user', s.user_id, { suspensionId: s.id });
    return { ok: true };
  });
  app.get('/admin/tickets', { preHandler: adminAuth }, async () => ({ tickets: db.prepare('SELECT t.*, u.username, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) AS messages FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC').all() }));
  app.get('/admin/tickets/:id', { preHandler: adminAuth }, async req => {
    const t = db.prepare('SELECT t.*, u.username FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').get((req.params as any).id);
    if (!t) throw new HttpError(404, 'NOT_FOUND');
    return { ticket: t, messages: db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all((t as any).id) };
  });
  app.post('/admin/tickets/:id/messages', { preHandler: adminAuth }, async req => {
    const id = (req.params as any).id; if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(id)) throw new HttpError(404, 'NOT_FOUND');
    const b = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    db.prepare('INSERT INTO ticket_messages (ticket_id,author,body,created_at) VALUES (?,?,?,?)').run(id, 'support', b.body, ctx.clock());
    return { ok: true };
  });
  app.patch('/admin/tickets/:id', { preHandler: adminAuth }, async req => {
    const b = z.object({ status: z.enum(['open', 'pending', 'resolved']) }).parse(req.body);
    db.prepare('UPDATE tickets SET status=? WHERE id=?').run(b.status, (req.params as any).id); return { ok: true };
  });
  app.get('/admin/workspaces', { preHandler: adminAuth }, async () => {
    const rows = db.prepare('SELECT w.*, (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id=w.id) AS members, (SELECT username FROM users WHERE id=w.created_by) AS owner FROM workspaces w ORDER BY w.created_at DESC').all() as any[];
    const active = rows.filter(w => !w.wrapped_at);
    const wrapped = rows.filter(w => !!w.wrapped_at);
    return {
      active,
      wrapped,
      stats: {
        active: active.length,
        wrapped: wrapped.length,
        members: rows.reduce((n, w) => n + Number(w.members || 0), 0),
      },
    };
  });
  app.get('/admin/audit', { preHandler: adminAuth }, async req => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const total = (db.prepare('SELECT COUNT(*) n FROM audit_log').get() as any).n;
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?').all(q.limit, q.offset) as any[];
    return {
      total,
      entries: rows.map(r => ({
        id: r.id, at: r.at, actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id,
        meta: r.meta ? JSON.parse(r.meta) : {},
      })),
    };
  });

  // ---------- background jobs (run by scheduler in index.ts; exposed for tests)
  const jobs = {
    /** Release held notifications for users whose shift has started; sends one summary push. */
    async releaseHeld() {
      const users = db.prepare('SELECT DISTINCT user_id FROM held_notifications WHERE released_at IS NULL').all() as any[];
      let released = 0;
      for (const { user_id } of users) {
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(user_id) as any;
        if (!u || !isOnShift(u, ctx.clock())) continue;
        const n = (db.prepare('SELECT COUNT(*) n FROM held_notifications WHERE user_id=? AND released_at IS NULL').get(user_id) as any).n;
        const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id=?').all(user_id) as any[];
        if (tokens.length) await ctx.push.send(tokens.map(t => ({ to: t.token, title: 'Good morning — your shift has started', body: `${n} update${n === 1 ? '' : 's'} held while you were off shift`, data: { kind: 'summary' }, sound: 'default' as const })));
        db.prepare('UPDATE held_notifications SET released_at=? WHERE user_id=? AND released_at IS NULL').run(ctx.clock(), user_id);
        ctx.emit.toUser(user_id, 'held:released', { count: n });
        released += n;
      }
      return released;
    },
    /** Delete wrapped workspaces after their 30-day archive window. */
    purgeWrapped() {
      const rows = db.prepare('SELECT id FROM workspaces WHERE delete_after IS NOT NULL AND delete_after < ?').all(ctx.clock()) as any[];
      for (const w of rows) {
        db.prepare('DELETE FROM conversations WHERE workspace_id=?').run(w.id);
        db.prepare('DELETE FROM workspaces WHERE id=?').run(w.id);
      }
      return rows.length;
    },
  };

  // ---------- call log helpers used by realtime layer
  const calls = {
    start(callId: string, caller: string, callee: string) {
      if (isBlocked(caller, callee)) throw new HttpError(403, 'BLOCKED');
      db.prepare("INSERT INTO calls (id,caller_id,callee_id,status,started_at) VALUES (?,?,?,'ringing',?)").run(callId, caller, callee, ctx.clock());
      const u = getUser(callee);
      return { calleeOnShift: isOnShift(u, ctx.clock()), callerName: getUser(caller).display_name };
    },
    get(callId: string) { return db.prepare('SELECT * FROM calls WHERE id=?').get(callId) as any; },
    answer(callId: string) { db.prepare("UPDATE calls SET status='active', answered_at=? WHERE id=? AND status='ringing'").run(ctx.clock(), callId); },
    end(callId: string, reason: string) {
      const c = db.prepare('SELECT * FROM calls WHERE id=?').get(callId) as any;
      if (!c || c.ended_at) return c;
      const status = c.status === 'active' ? 'completed' : reason === 'declined' ? 'declined' : reason === 'held' ? 'held' : 'missed';
      db.prepare('UPDATE calls SET status=?, ended_at=?, end_reason=? WHERE id=?').run(status, ctx.clock(), reason, callId);
      return db.prepare('SELECT * FROM calls WHERE id=?').get(callId);
    },
    notify,
  };

  registerMlsRoutes(app, ctx, { auth, getUser, memberOf, convMembers, rateLimit });

  return { app, ctx, jobs, calls, joinWorkspace };
}

export type Built = ReturnType<typeof buildApp>;
