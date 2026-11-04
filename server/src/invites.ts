import type { Config } from './config.js';
import { HttpError, hmac, safeEq } from './util.js';

/** Signed invite token: base64url(json).sig — HMAC-SHA256. Also stored server-side for revocation. */
export function signInvite(cfg: Config, payload: { id: string; k: string; exp: number }) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `us1.${body}.${hmac(cfg.inviteSecret, body)}`;
}

export function verifyInvite(cfg: Config, token: string, at = Date.now()) {
  const m = /^us1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || '').replace(/^understage:\/\/invite\//, ''));
  if (!m) throw new HttpError(400, 'INVITE_INVALID', 'This code is not an Understage invite');
  if (!safeEq(hmac(cfg.inviteSecret, m[1]), m[2])) throw new HttpError(400, 'INVITE_INVALID', 'This invite has been tampered with');
  let p: { id: string; k: string; exp: number };
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { throw new HttpError(400, 'INVITE_INVALID'); }
  if (p.exp < at) throw new HttpError(410, 'INVITE_EXPIRED', 'This invite has expired. Ask for a fresh code.');
  return p;
}
