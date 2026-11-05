import { buildApp } from '../src/app';
import { MemoryPushSender, ConsoleOtpSender } from '../src/providers';
import { generateIdentity, type Identity } from '../../shared/e2ee';

export function setup(clock?: () => number, cfg?: { mlsDirectoryEnabled?: boolean }) {
  const push = new MemoryPushSender();
  const otp = new ConsoleOtpSender();
  const events: { user: string; event: string; data: any }[] = [];
  const built = buildApp({ push, otp, clock, cfg, emit: { toUser: (user, event, data) => { events.push({ user, event, data }); }, isOnline: () => false } });
  return { ...built, push, otp, events };
}

let phoneN = 100000;
export interface TUser { id: string; token: string; refresh: string; id_: Identity; username: string }

export async function signup(t: ReturnType<typeof setup>, username: string, extra: Record<string, unknown> = {}): Promise<TUser> {
  const destination = `+4477009${phoneN++}`;
  const r1 = await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { kind: 'phone', destination } });
  const code = r1.json().devCode;
  const r2 = await t.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination, code } });
  const { accessToken, refreshToken, user } = r2.json();
  const id_ = generateIdentity();
  const h = { authorization: `Bearer ${accessToken}` };
  await t.app.inject({ method: 'PATCH', url: '/me', headers: h, payload: { displayName: username, username, role: 'Crew', quietHours: false, ...extra } });
  await t.app.inject({ method: 'PUT', url: '/me/keys', headers: h, payload: { identityKey: id_.publicKey } });
  return { id: user.id, token: accessToken, refresh: refreshToken, id_, username };
}

export const H = (u: TUser) => ({ authorization: `Bearer ${u.token}` });

export function grantPlan(t: ReturnType<typeof setup>, user: TUser, plan: 'production' | 'company', renewsAt?: number) {
  t.ctx.db.prepare("UPDATE users SET plan=?, plan_status='trial', plan_renews_at=? WHERE id=?").run(plan, renewsAt ?? (Date.now() + 14 * 86_400_000), user.id);
}

