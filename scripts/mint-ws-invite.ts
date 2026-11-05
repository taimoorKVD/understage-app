
import fs from 'node:fs';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const PHONE = '+447700900300';
const ALEX = 'u_FAl8p1_6KbKa';
const WS = 'w_M2IFshcmKU84';
const OUT = process.env.OUT || '/tmp/ws-invite.json';

async function json(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 300)}`);
  return body;
}

async function main() {
  const reqOtp = await json(await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE }),
  }));
  if (!reqOtp?.devCode) throw new Error('no dev OTP');
  const session = await json(await fetch(`${API}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE, code: String(reqOtp.devCode) }),
  }));
  if (session.user?.id !== ALEX) throw new Error(`unexpected user ${session.user?.id}`);
  const inv = await json(await fetch(`${API}/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'workspace', workspaceId: WS, ttlSec: 3600 }),
  }));
  if (!inv?.token || !inv?.url || !inv?.id) throw new Error('invite missing fields');
  fs.writeFileSync(OUT, JSON.stringify({ id: inv.id, url: inv.url, token: inv.token, workspaceId: WS }, null, 2));
  console.log(JSON.stringify({ ok: true, id: inv.id, workspaceId: WS, urlScheme: 'understage://invite/<token>' }));
}
main().catch(e => { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1); });
