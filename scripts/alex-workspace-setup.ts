/**
 * As Alex: free one synthetic TEST seat if needed, mint a workspace invite for
 * Hamlet UK Tour 2027 (TEST), and (once the phone user is a member) assign a
 * department and post a require-ack announcement. Does not print tokens/OTP.
 *
 * MODE=invite|announce|auto  (auto = invite, then announce if already a member)
 */
import fs from 'node:fs';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const PHONE = '+447700900300';
const ALEX = 'u_FAl8p1_6KbKa';
const PEER = 'u_875nDU6SAca7';
const WS = 'w_M2IFshcmKU84';
const DEPT = process.env.DEPARTMENT_ID || 'd_fUMdmARHgRig'; // Stage Management
const OUT = process.env.OUT || '/tmp/understage-workspace-setup.json';
const MODE = process.env.MODE || 'auto';

function header(token: string, jsonBody = false) {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (jsonBody) h['Content-Type'] = 'application/json';
  return h;
}

async function json(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 300)}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

async function login() {
  const reqOtp = await json(await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE }),
  }));
  if (!reqOtp?.devCode) throw new Error('dev OTP was not returned');
  const session = await json(await fetch(`${API}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE, code: String(reqOtp.devCode) }),
  }));
  if (session.user?.id && session.user.id !== ALEX) throw new Error(`unexpected user ${session.user.id}`);
  return session.accessToken as string;
}

async function memberCount(token: string) {
  const page = await json(await fetch(`${API}/workspaces/${WS}/members?limit=1`, { headers: header(token) }));
  return page.total as number;
}

async function isMember(token: string) {
  const page = await json(await fetch(`${API}/workspaces/${WS}/members?q=syed.umar&limit=10`, { headers: header(token) }));
  return (page.members || []).some((m: any) => m.id === PEER);
}

async function main() {
  const token = await login();
  const result: any = { ok: true, mode: MODE, workspaceId: WS, phoneUserId: PEER, departmentId: DEPT };

  const already = await isMember(token);
  result.alreadyMember = already;
  result.memberCountBefore = await memberCount(token);

  if (!already && (MODE === 'invite' || MODE === 'auto')) {
    const page = await json(await fetch(`${API}/workspaces/${WS}/members?q=h200.willa.frost197&limit=5`, { headers: header(token) }));
    const victim = (page.members || []).find((m: any) => m.wsRole === 'member' && String(m.username || '').startsWith('h200.'))
      || (page.members || []).find((m: any) => m.wsRole === 'member');
    if (!victim?.id) throw new Error('no synthetic member found to free a seat');
    await json(await fetch(`${API}/workspaces/${WS}/members/${victim.id}`, { method: 'DELETE', headers: header(token) }));
    result.freedSeat = { id: victim.id, username: victim.username };
    result.memberCountAfterFree = await memberCount(token);
    const invite = await json(await fetch(`${API}/invites`, {
      method: 'POST', headers: header(token, true),
      body: JSON.stringify({ kind: 'workspace', workspaceId: WS, ttlSec: 7 * 86400 }),
    }));
    result.invite = { id: invite.id, token: invite.token, url: invite.url, expiresAt: invite.expiresAt };
  }

  const memberNow = already || await isMember(token);
  result.phoneIsMember = memberNow;

  if (memberNow && (MODE === 'announce' || MODE === 'auto')) {
    await json(await fetch(`${API}/workspaces/${WS}/members/${PEER}`, {
      method: 'PATCH', headers: header(token, true),
      body: JSON.stringify({ departmentId: DEPT }),
    }));
    result.departmentAssigned = DEPT;
    const posted = await json(await fetch(`${API}/workspaces/${WS}/announcements`, {
      method: 'POST', headers: header(token, true),
      body: JSON.stringify({
        title: 'Call sheet — please acknowledge',
        body: 'This is a TEST announcement for physical-iPhone QA of Hamlet UK Tour 2027 (TEST). Please tap Acknowledge so we can verify receipts. No production data.',
        requireAck: true,
        respectQuietHours: false,
      }),
    }));
    result.announcement = {
      id: posted.announcement?.id,
      title: posted.announcement?.title,
      requireAck: posted.announcement?.requireAck,
      recipients: posted.recipients,
    };
  }

  result.memberCountAfter = await memberCount(token);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    ok: true,
    mode: MODE,
    alreadyMember: result.alreadyMember,
    phoneIsMember: result.phoneIsMember,
    memberCountBefore: result.memberCountBefore,
    freedUsername: result.freedSeat?.username,
    memberCountAfterFree: result.memberCountAfterFree,
    inviteId: result.invite?.id,
    inviteUrlScheme: result.invite?.url ? String(result.invite.url).split('/').slice(0, 3).join('/') + '/<token>' : null,
    departmentAssigned: result.departmentAssigned || null,
    announcementId: result.announcement?.id || null,
    announcementRecipients: result.announcement?.recipients ?? null,
    memberCountAfter: result.memberCountAfter,
  }, null, 2));
}

main().catch((e) => {
  const out = { ok: false, error: String(e?.message || e) };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(JSON.stringify(out));
  process.exit(1);
});
