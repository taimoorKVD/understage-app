/**
 * Seeds the demo company "Hamlet UK Tour 2027" (200 members, 8 departments) through the REAL API
 * code paths (OTP signup, PATCH /me, PUT /me/keys, workspaces, announcements, acks).
 *
 *   DB_FILE=./understage.db npm run seed            # owner phone +447700900001
 *   SEED_OWNER_PHONE=+447700900123 npm run seed      # sign in on the phone with this number to be the owner
 *
 * Demo-member key pairs are written to ./data/seed-keys.json (dev only) so scripts/demo-crew.ts can
 * reply to you with genuinely end-to-end-encrypted messages.
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { ConsoleOtpSender, MemoryPushSender } from '../src/providers.js';
import { generateIdentity } from '../../shared/e2ee';

const cfg = loadConfig({ devReturnOtp: true });
fs.mkdirSync(path.dirname(path.resolve(cfg.dbFile)), { recursive: true });
if (fs.existsSync(cfg.dbFile) && process.env.SEED_RESET !== '0') { fs.rmSync(cfg.dbFile); for (const s of ['-wal', '-shm']) fs.rmSync(cfg.dbFile + s, { force: true }); }
const otp = new ConsoleOtpSender(); (otp as any).log = false;
const origLog = console.log; console.log = (...a: unknown[]) => { if (!String(a[0]).startsWith('[otp]')) origLog(...a); };
const db = openDb(cfg.dbFile);
const { app } = buildApp({ db, cfg, otp, push: new MemoryPushSender() });
const joinWorkspace = (app as any).joinWorkspace as (w: string, u: string, r: string, d: string | null, c?: string) => void;

const DEPS: [string, number][] = [['Stage Management', 12], ['Cast', 32], ['Lighting', 18], ['Sound', 14], ['Wardrobe & Wigs', 16], ['Set & Crew', 46], ['Front of House', 52], ['Production Office', 10]];
// named colleagues from the prototype (name, username, role, department, city, tz, quiet/workDays)
const NAMED: [string, string, string, string, string, string][] = [
  ['Marcus Webb', 'marcus.lx', 'Lighting Designer', 'Lighting', 'London', 'Europe/London'],
  ['Priya Nair', 'priya.dsm', 'Deputy SM', 'Stage Management', 'London', 'Europe/London'],
  ['Jess Moreau', 'jess.prog', 'Programmer', 'Lighting', 'Paris', 'Europe/Paris'],
  ['Daniel Osei', 'daniel.pm', 'Production Manager', 'Production Office', 'New York', 'America/New_York'],
  ['Kenji Sato', 'kenji.video', 'Video Designer', 'Set & Crew', 'Tokyo', 'Asia/Tokyo'],
  ['Marcus Adeyemi', 'm.adeyemi', 'Sound No.1', 'Sound', 'London', 'Europe/London'],
  ['Emma Hart', 'emma.wardrobe', 'Wardrobe', 'Wardrobe & Wigs', 'London', 'Europe/London'],
  ['Marcia Lowe', 'marcia.props', 'Props Supervisor', 'Set & Crew', 'London', 'Europe/London'],
];
const FIRST = ['Alex', 'Sam', 'Jordan', 'Charlie', 'Ruby', 'Leo', 'Maya', 'Isla', 'Noah', 'Aisha', 'Tom', 'Hannah', 'Ollie', 'Freya', 'Ravi', 'Zoe', 'Ben', 'Chloe', 'Kai', 'Nina', 'Finn', 'Lola', 'Omar', 'Grace', 'Theo'];
const LAST = ['Patel', 'Clarke', 'Evans', 'Murphy', 'Okafor', 'Shaw', 'Byrne', 'Khan', 'Price', 'Doyle', 'Hughes', 'Reid', 'Ali', 'Fraser', 'Walsh', 'Bell', 'Kerr', 'Lynch', 'Moss', 'Quinn'];
const ROLE: Record<string, string[]> = {
  'Stage Management': ['ASM', 'DSM', 'Company Stage Manager'], Cast: ['Actor', 'Understudy', 'Swing'], Lighting: ['Electrician', 'Follow Spot Op', 'Production LX'],
  Sound: ['Sound No.2', 'RF Tech', 'Sound Op'], 'Wardrobe & Wigs': ['Dresser', 'Wigs Assistant', 'Wardrobe Mistress'], 'Set & Crew': ['Stage Crew', 'Flyman', 'Carpenter'],
  'Front of House': ['Usher', 'Box Office', 'FOH Manager'], 'Production Office': ['Company Manager', 'Production Assistant', 'Tour Booker'],
};

const keys: Record<string, { username: string; phone: string; userId: string; publicKey: string; secretKey: string }> = {};
let phoneN = 900100;
async function create(phone: string, profile: Record<string, unknown>, withKey = true) {
  const r1 = await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { kind: 'phone', destination: phone } });
  const r2 = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { kind: 'phone', destination: phone, code: r1.json().devCode } });
  const { accessToken, user } = r2.json();
  const h = { authorization: `Bearer ${accessToken}` };
  const p = await app.inject({ method: 'PATCH', url: '/me', headers: h, payload: profile });
  if (p.statusCode !== 200) throw new Error(`profile ${JSON.stringify(profile)}: ${p.body}`);
  if (withKey) {
    const id = generateIdentity();
    await app.inject({ method: 'PUT', url: '/me/keys', headers: h, payload: { identityKey: id.publicKey } });
    keys[profile.username as string] = { username: profile.username as string, phone, userId: user.id, ...id };
  }
  return { id: user.id as string, h };
}

const ownerPhone = process.env.SEED_OWNER_PHONE || '+447700900001';
// Owner is created WITHOUT a key so that the real phone generates & publishes its own key at onboarding step 5.
const owner = await create(ownerPhone, { displayName: 'Sophie Marlowe', username: 'sophie.sm', role: 'Company Stage Manager', department: 'Stage Management', quietHours: true, workDays: [0, 1, 2, 3, 4, 5], shiftStart: '12:00', shiftEnd: '23:30', timezone: 'Europe/London' }, false);
const wsRes = await app.inject({ method: 'POST', url: '/workspaces', headers: owner.h, payload: { name: 'Hamlet UK Tour 2027', venue: 'Lyceum, Edinburgh', runLabel: '12 Jan – 28 Jun 2027 · 9 venues', departments: DEPS.map(d => d[0]) } });
if (wsRes.statusCode !== 200) throw new Error(wsRes.body);
const ws = wsRes.json().workspace;
const deptId = (name: string) => ws.departments.find((d: any) => d.name === name).id;
// put owner into Stage Management
db.prepare('UPDATE workspace_members SET department_id=?, city=? WHERE workspace_id=? AND user_id=?').run(deptId('Stage Management'), 'Edinburgh', ws.id, owner.id);

const remaining = Object.fromEntries(DEPS.map(([n, c]) => [n, c])) as Record<string, number>;
remaining['Stage Management']--; // owner
const members: { id: string; h: any; dept: string }[] = [];
for (const [name, username, role, dept, city, tz] of NAMED) {
  const quiet = username === 'kenji.video'; // Tokyo night → shows the off-shift overlay
  const m = await create(`+44770${phoneN++}`, { displayName: name, username, role, department: dept, timezone: tz, quietHours: quiet, workDays: [0, 1, 2, 3, 4, 5], shiftStart: '10:00', shiftEnd: '22:00', followPhoneTz: false });
  joinWorkspace(ws.id, m.id, username === 'priya.dsm' || username === 'daniel.pm' ? 'admin' : 'member', deptId(dept), city);
  remaining[dept]--; members.push({ ...m, dept });
}
let n = 0;
for (const [dept] of DEPS) {
  while (remaining[dept] > 0) {
    const first = FIRST[n % FIRST.length], last = LAST[Math.floor(n / FIRST.length) % LAST.length];
    const username = `${first}.${last}${n}`.toLowerCase();
    const off = n % 5 === 0; // ~20% have quiet hours on & are off shift tonight
    const m = await create(`+44770${phoneN++}`, { displayName: `${first} ${last}`, username, role: ROLE[dept][n % 3], department: dept, timezone: 'Europe/London', quietHours: off, workDays: off ? [] : [0, 1, 2, 3, 4, 5, 6], shiftStart: '09:00', shiftEnd: '23:59' }, n < 40);
    joinWorkspace(ws.id, m.id, 'member', deptId(dept), 'Edinburgh');
    remaining[dept]--; members.push({ ...m, dept }); n++;
  }
}
const count = (await app.inject({ method: 'GET', url: `/workspaces/${ws.id}`, headers: owner.h })).json().workspace.memberCount;

// Announcement with acknowledgements (the prototype shows 141/200 style progress)
const ann = (await app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: owner.h, payload: { title: 'Fire drill before tonight’s show', body: 'Full company on stage at 18:15 for the venue fire drill. Assemble at the stage door muster point. Takes 10 minutes.', requireAck: true, respectQuietHours: true } })).json();
for (const m of members.slice(0, 140)) await app.inject({ method: 'POST', url: `/announcements/${ann.announcement.id}/ack`, headers: m.h });
for (const m of members.slice(140, 160)) await app.inject({ method: 'POST', url: `/announcements/${ann.announcement.id}/seen`, headers: m.h });
await app.inject({ method: 'POST', url: `/workspaces/${ws.id}/announcements`, headers: owner.h, payload: { title: 'Get-out schedule · Edinburgh', body: 'Get-out starts straight after Saturday’s evening show. Trucks loading from 23:00.', requireAck: false, respectQuietHours: true } });

// Group chat used in the prototype (members only; messages are encrypted on devices, so none are seeded)
const lx = members.filter(m => ['Lighting', 'Sound'].includes(m.dept)).slice(0, 9).map(m => m.id);
await app.inject({ method: 'POST', url: '/conversations', headers: owner.h, payload: { kind: 'group', title: 'LX & Sound', memberIds: lx } });
// The owner's contacts: the named colleagues
for (const m of members.slice(0, NAMED.length)) await app.inject({ method: 'POST', url: '/contacts', headers: owner.h, payload: { userId: m.id } });

fs.mkdirSync('./data', { recursive: true });
fs.writeFileSync('./data/seed-keys.json', JSON.stringify({ ownerPhone, workspaceId: ws.id, members: keys }, null, 2));
origLog(`Seeded "${ws.name}" (${count} members, ${DEPS.length} departments) into ${cfg.dbFile}`);
origLog(`Sign in on the app with phone ${ownerPhone} to be the owner (Sophie Marlowe, @sophie.sm). Dev OTP codes are printed by the server.`);
await app.close();
