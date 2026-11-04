import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { HttpError, now, sha256, uid } from './util.js';

export interface AccessClaims { sub: string; sid: string; typ: 'access' }

export function identifierHash(cfg: Config, kind: string, dest: string) {
  const norm = kind === 'email' ? dest.trim().toLowerCase() : dest.replace(/[^\d+]/g, '');
  return sha256(cfg.identifierPepper + ':' + kind + ':' + norm);
}

export function validateDestination(kind: string, dest: string) {
  if (kind === 'phone') {
    const d = dest.replace(/[^\d+]/g, '');
    if (!/^\+\d{8,15}$/.test(d)) throw new HttpError(400, 'INVALID_PHONE', 'Enter a valid mobile number with country code');
    return d;
  }
  if (kind === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest.trim())) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address');
    return dest.trim().toLowerCase();
  }
  throw new HttpError(400, 'INVALID_KIND');
}

export function issueSession(db: DB, cfg: Config, userId: string) {
  const sid = uid('s_');
  const refresh = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id,user_id,refresh_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(sid, userId, sha256(refresh), now(), now() + cfg.refreshTtlSec * 1000);
  return { accessToken: signAccess(cfg, userId, sid), refreshToken: `${sid}.${refresh}` };
}

export function signAccess(cfg: Config, userId: string, sid: string) {
  return jwt.sign({ sub: userId, sid, typ: 'access' } satisfies AccessClaims, cfg.jwtSecret, { expiresIn: cfg.accessTtlSec, algorithm: 'HS256' });
}

export function verifyAccess(db: DB, cfg: Config, token: string): AccessClaims {
  let c: AccessClaims;
  try { c = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] }) as AccessClaims; }
  catch (e) { throw new HttpError(401, (e as Error).name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED'); }
  if (c.typ !== 'access') throw new HttpError(401, 'UNAUTHORIZED');
  const s = db.prepare('SELECT revoked FROM sessions WHERE id=?').get(c.sid) as { revoked: number } | undefined;
  if (!s || s.revoked) throw new HttpError(401, 'SESSION_REVOKED');
  const u = db.prepare('SELECT suspended_until FROM users WHERE id=?').get(c.sub) as { suspended_until: number | null } | undefined;
  if (!u) throw new HttpError(401, 'UNAUTHORIZED');
  if (u.suspended_until && u.suspended_until > now()) throw new HttpError(403, 'SUSPENDED', 'This account is suspended');
  return c;
}

export function rotateRefresh(db: DB, cfg: Config, token: string) {
  const [sid, secret] = String(token).split('.');
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid) as any;
  if (!s || s.revoked || s.expires_at < now() || s.refresh_hash !== sha256(secret || '')) {
    if (s && s.refresh_hash !== sha256(secret || '')) db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(sid); // reuse detection
    throw new HttpError(401, 'INVALID_REFRESH');
  }
  const next = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE sessions SET refresh_hash=?, expires_at=? WHERE id=?').run(sha256(next), now() + cfg.refreshTtlSec * 1000, sid);
  return { accessToken: signAccess(cfg, s.user_id, sid), refreshToken: `${sid}.${next}` };
}

export function genOtp() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
