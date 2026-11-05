/**
 * Isolated dev seed: "Hamlet UK Tour 2027 (TEST)" with ~200 synthetic members.
 * Refuses to run when NODE_ENV=production. Does not reset the database and does
 * not touch any workspace or user other than this TEST company and `h200.*` users.
 *
 *   cd server && npx tsx scripts/seed-hamlet-200.ts
 *
 * Owner: existing Simulator account Alex Rivera (+44 7700900300) — granted a
 * Company plan so the workspace appears under his seats.
 */
import '../src/env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run seed-hamlet-200 when NODE_ENV=production');
  process.exit(1);
}

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { identifierHash } from '../src/auth.js';
import { uid } from '../src/util.js';
import crypto from 'node:crypto';

const WS_NAME = 'Hamlet UK Tour 2027 (TEST)';
const USER_PREFIX = 'h200.';
const ALEX_PHONE = (process.env.SEED_ALEX_PHONE || '+447700900300').replace(/[^\d+]/g, '');

/** 8 departments — counts include Alex in Stage Management so the company totals 200. */
const DEPS: [string, number][] = [
  ['Stage Management', 12], // 11 synthetics + Alex
  ['Cast', 34],
  ['Lighting', 18],
  ['Sound', 14],
  ['Wardrobe & Wigs', 42],
  ['Set & Crew', 30],
  ['Front of House', 40],
  ['Production Office', 10],
];

const FIRST = ['Amelia', 'Noah', 'Harper', 'Oscar', 'Ivy', 'Felix', 'Sienna', 'Arthur', 'Clara', 'Miles', 'Eliza', 'Hugo', 'Imogen', 'Reuben', 'Ottilie', 'Jasper', 'Maeve', 'Caleb', 'Daphne', 'Luca', 'Rosa', 'Edwin', 'Willa', 'Nico', 'Thea'];
const LAST = ['Hart', 'Cole', 'Nash', 'Vance', 'Brooks', 'Blair', 'Rowe', 'Frost', 'Dalton', 'Hayes', 'Pryor', 'West', 'Lang', 'Crowe', 'Baines', 'Phelps', 'York', 'Marsh', 'Sloan', 'Keene'];
const ROLE: Record<string, string[]> = {
  'Stage Management': ['ASM', 'DSM', 'Company Stage Manager', 'Stage Manager'],
  Cast: ['Actor', 'Understudy', 'Swing', 'Dance Captain'],
  Lighting: ['Electrician', 'Follow Spot Op', 'Production LX', 'LX Programmer'],
  Sound: ['Sound No.2', 'RF Tech', 'Sound Op', 'Sound No.1'],
  'Wardrobe & Wigs': ['Dresser', 'Wigs Assistant', 'Wardrobe Mistress', 'Wig Supervisor'],
  'Set & Crew': ['Stage Crew', 'Flyman', 'Carpenter', 'Rigger'],
  'Front of House': ['Usher', 'Box Office', 'FOH Manager', 'Duty Manager'],
  'Production Office': ['Company Manager', 'Production Assistant', 'Tour Booker', 'Producer'],
};
const PLACES: { city: string; tz: string }[] = [
  { city: 'London', tz: 'Europe/London' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Edinburgh', tz: 'Europe/London' },
  { city: 'Manchester', tz: 'Europe/London' },
  { city: 'New York', tz: 'America/New_York' },
  { city: 'New York', tz: 'America/New_York' },
  { city: 'Chicago', tz: 'America/Chicago' },
  { city: 'Los Angeles', tz: 'America/Los_Angeles' },
  { city: 'Paris', tz: 'Europe/Paris' },
  { city: 'Berlin', tz: 'Europe/Berlin' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
  { city: 'Sydney', tz: 'Australia/Sydney' },
];

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const cfg = loadConfig();
const dbPath = path.resolve(cfg.dbFile);
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}

const db = openDb(cfg.dbFile);
db.pragma('wal_checkpoint(FULL)');
const backupPath = `${dbPath}.bak-${stamp()}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`Backed up DB to ${backupPath}`);

const alexIh = identifierHash(cfg, 'phone', ALEX_PHONE);
const alex = (db.prepare('SELECT * FROM users WHERE identifier_hash=?').get(alexIh)
  || db.prepare("SELECT * FROM users WHERE display_name = 'Alex Rivera'").get()) as any;
if (!alex) {
  console.error(`Alex Rivera (${ALEX_PHONE}) was not found. Refusing to invent an owner.`);
  process.exit(1);
}

const now = Date.now();

function teardown() {
  const existing = db.prepare('SELECT * FROM workspaces WHERE name=?').get(WS_NAME) as any;
  const h200 = db.prepare("SELECT id FROM users WHERE username LIKE 'h200.%'").all() as { id: string }[];
  const ids = h200.map((u) => u.id);
  if (existing) {
    const convs = db.prepare('SELECT id FROM conversations WHERE workspace_id=? OR (kind=? AND title LIKE ? AND created_by=?)')
      .all(existing.id, 'group', '% (TEST)', alex.id) as { id: string }[];
    const delConv = db.prepare('DELETE FROM conversations WHERE id=?');
    for (const c of convs) delConv.run(c.id);
    db.prepare('DELETE FROM announcements WHERE workspace_id=?').run(existing.id);
    db.prepare('DELETE FROM workspaces WHERE id=?').run(existing.id);
  } else {
    const convs = db.prepare("SELECT id FROM conversations WHERE kind='group' AND title LIKE ? AND created_by=?")
      .all('% (TEST)', alex.id) as { id: string }[];
    for (const c of convs) db.prepare('DELETE FROM conversations WHERE id=?').run(c.id);
  }
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM reports WHERE reporter_id IN (${ph}) OR reported_id IN (${ph})`).run(...ids, ...ids);
    const tickets = db.prepare(`SELECT id FROM tickets WHERE user_id IN (${ph})`).all(...ids) as { id: string }[];
    for (const t of tickets) db.prepare('DELETE FROM tickets WHERE id=?').run(t.id);
    db.prepare(`DELETE FROM suspensions WHERE user_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM held_notifications WHERE user_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM contacts WHERE owner_id IN (${ph}) OR contact_id IN (${ph})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids);
  }
}

const run = db.transaction(() => {
  teardown();

  db.prepare("UPDATE users SET plan='company', plan_status='trial', plan_renews_at=? WHERE id=?")
    .run(now + 14 * 86_400_000, alex.id);

  const wsId = uid('w_');
  db.prepare('INSERT INTO workspaces (id,name,initial,venue,run_label,seat_limit,plan,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(wsId, WS_NAME, 'H', 'Lyceum, Edinburgh (TEST)', '12 Jan – 28 Jun 2027 · TEST', 200, 'company', alex.id, now);

  const deptIds: Record<string, string> = {};
  DEPS.forEach(([name], i) => {
    const id = uid('d_');
    db.prepare('INSERT INTO departments (id, workspace_id, name, sort) VALUES (?,?,?,?)').run(id, wsId, name, i);
    deptIds[name] = id;
  });

  const convId = uid('c_');
  db.prepare('INSERT INTO conversations (id,kind,title,workspace_id,created_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(convId, 'workspace', WS_NAME, wsId, alex.id, now);

  const addMember = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role,department_id,city,joined_at) VALUES (?,?,?,?,?,?)');
  const addConvMem = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)');

  addMember.run(wsId, alex.id, 'owner', deptIds['Stage Management'], 'Edinburgh', now);
  addConvMem.run(convId, alex.id, 'admin', now);

  type Synth = { id: string; username: string; display: string; dept: string; city: string; tz: string; quiet: number; workDays: string };
  const synthetics: Synth[] = [];
  const usedNames = new Set<string>();
  let n = 0;
  const needed = DEPS.reduce((s, [, c]) => s + c, 0) - 1; // everyone except Alex

  const insUser = db.prepare(`INSERT INTO users (
    id, identifier_hash, identifier_kind, display_name, username, role, department,
    timezone, follow_phone_tz, touring_mode, quiet_hours, work_days, shift_start, shift_end, work_mode, created_at,
    identity_key, key_updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const [dept, count] of DEPS) {
    const take = dept === 'Stage Management' ? count - 1 : count;
    for (let i = 0; i < take; i++) {
      if (n >= needed) break;
      let first = FIRST[n % FIRST.length];
      let last = LAST[Math.floor(n / FIRST.length) % LAST.length];
      let display = `${first} ${last}`;
      let uname = `${USER_PREFIX}${first}.${last}${n}`.toLowerCase();
      while (usedNames.has(uname) || db.prepare('SELECT 1 FROM users WHERE username=?').get(uname)) {
        n += 1;
        first = FIRST[n % FIRST.length];
        last = LAST[Math.floor(n / FIRST.length) % LAST.length];
        display = `${first} ${last}`;
        uname = `${USER_PREFIX}${first}.${last}${n}`.toLowerCase();
      }
      usedNames.add(uname);
      const place = PLACES[n % PLACES.length];
      const roles = ROLE[dept];
      const role = roles[n % roles.length];
      // ~1 in 8 always off-shift (empty work days + quiet hours) so reminders are held.
      const offShift = n % 8 === 3;
      const phone = `+4477182${String(n + 1).padStart(5, '0')}`;
      const id = uid('u_');
      insUser.run(
        id,
        identifierHash(cfg, 'phone', phone),
        'phone',
        display,
        uname,
        role,
        dept,
        place.tz,
        1,
        0,
        offShift ? 1 : (n % 5 === 0 ? 1 : 0),
        offShift ? '[]' : '[0,1,2,3,4,5]',
        '12:00',
        '23:30',
        1,
        now - n * 1000,
        crypto.randomBytes(32).toString('base64'),
        now,
      );
      addMember.run(wsId, id, n % 17 === 0 ? 'admin' : 'member', deptIds[dept], place.city, now);
      addConvMem.run(convId, id, 'member', now);
      synthetics.push({
        id, username: uname, display, dept, city: place.city, tz: place.tz,
        quiet: offShift ? 1 : (n % 5 === 0 ? 1 : 0),
        workDays: offShift ? '[]' : '[0,1,2,3,4,5]',
      });
      n += 1;
    }
  }

  const memberCount = (db.prepare('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id=?').get(wsId) as any).n as number;
  if (memberCount !== 200) {
    throw new Error(`Expected 200 members, got ${memberCount}`);
  }

  // Groups of 50 or fewer, all including Alex so they appear in the Simulator chat list.
  function makeGroup(title: string, userIds: string[]) {
    const unique = Array.from(new Set([alex.id, ...userIds]));
    if (unique.length > 50) unique.length = 50;
    const gid = uid('c_');
    db.prepare('INSERT INTO conversations (id,kind,title,workspace_id,created_by,created_at) VALUES (?,?,?,?,?,?)')
      .run(gid, 'group', title, null, alex.id, now);
    addConvMem.run(gid, alex.id, 'admin', now);
    for (const id of unique) {
      if (id === alex.id) continue;
      addConvMem.run(gid, id, 'member', now);
    }
    return gid;
  }
  const byDept = (name: string) => synthetics.filter((s) => s.dept === name).map((s) => s.id);
  makeGroup('LX & Sound (TEST)', [...byDept('Lighting'), ...byDept('Sound')]);
  makeGroup('Wardrobe (TEST)', byDept('Wardrobe & Wigs').slice(0, 40));
  makeGroup('Cast company (TEST)', byDept('Cast'));

  // Contacts so the attach-contact sheet has people to pick.
  const addContact = db.prepare('INSERT OR IGNORE INTO contacts (owner_id, contact_id, verified, created_at) VALUES (?,?,1,?)');
  for (const s of synthetics.slice(0, 12)) addContact.run(alex.id, s.id, now);

  // Announcement: insert ALL 200 members (including the owner) as recipients so the
  // ack counter can read 142/200. Ack 142 synthetics; leave Alex pending so he can Acknowledge.
  const annId = uid('a_');
  db.prepare('INSERT INTO announcements (id,workspace_id,author_id,title,body,require_ack,respect_quiet,department_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(annId, wsId, alex.id, 'Half-hour call — Act I (TEST)',
      'Half-hour call for tonight\'s Act I. Please acknowledge when you have read this. Held notes stay quiet for anyone off shift.',
      1, 1, null, now - 3600_000);
  const insRec = db.prepare('INSERT INTO announcement_recipients (announcement_id,user_id,seen_at,acked_at,reminded_at) VALUES (?,?,?,?,?)');
  insRec.run(annId, alex.id, null, null, null);
  const ACK_TARGET = 142;
  synthetics.forEach((s, i) => {
    if (i < ACK_TARGET) {
      insRec.run(annId, s.id, now - 2400_000, now - 1800_000, null);
    } else if (i < ACK_TARGET + 16) {
      insRec.run(annId, s.id, now - 1200_000, null, null);
    } else if (s.workDays === '[]') {
      insRec.run(annId, s.id, null, null, now - 60_000);
      db.prepare('INSERT INTO held_notifications (user_id,kind,conversation_id,title,created_at) VALUES (?,?,?,?,?)')
        .run(s.id, 'announcement', null, '📣 Reminder held — off shift', now - 60_000);
    } else {
      insRec.run(annId, s.id, null, null, null);
    }
  });

  // Isolated report, ticket, and suspension so the web admin is not an empty queue.
  const reporter = synthetics[0];
  const reported = synthetics[1];
  const suspended = synthetics[2];
  const ticketUser = synthetics[3];
  db.prepare('INSERT INTO reports (id,number,reporter_id,reported_id,reason,evidence,also_blocked,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid('r_'), 2101, reporter.id, reported.id, 'spam', JSON.stringify([
      { text: 'I can get you backstage passes for cash, DM me', at: now - 7200_000 },
      { text: 'Send me your login code and I will sort the list', at: now - 6900_000 },
    ]), 0, 'open', now - 5400_000);
  db.prepare('INSERT INTO tickets (id,user_id,subject,created_at) VALUES (?,?,?,?)')
    .run(uid('t_'), ticketUser.id, 'Cannot see tonight\'s half-hour call', now - 4000_000);
  const ticket = db.prepare("SELECT id FROM tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(ticketUser.id) as any;
  db.prepare('INSERT INTO ticket_messages (ticket_id,author,body,created_at) VALUES (?,?,?,?)')
    .run(ticket.id, 'user', 'The half-hour call appeared for others but I never got the notification. Can someone check my hours?', now - 4000_000);
  const until = now + 7 * 86_400_000;
  db.prepare('INSERT INTO suspensions (id,user_id,duration,reason,until,created_by,created_at,lifted) VALUES (?,?,?,?,?,?,?,0)')
    .run(uid('x_'), suspended.id, '7d', 'TEST: temporary suspension for admin review', until, 'admin', now - 86_400_000);
  db.prepare('UPDATE users SET suspended_until=?, suspension_reason=? WHERE id=?')
    .run(until, 'TEST: temporary suspension for admin review', suspended.id);

  return { wsId, convId, annId, memberCount, synthetics, ackTarget: ACK_TARGET };
});

const result = run();

const acked = (db.prepare('SELECT COUNT(*) n FROM announcement_recipients WHERE announcement_id=? AND acked_at IS NOT NULL').get(result.annId) as any).n;
const pending = (db.prepare('SELECT COUNT(*) n FROM announcement_recipients WHERE announcement_id=? AND acked_at IS NULL').get(result.annId) as any).n;
const recips = (db.prepare('SELECT COUNT(*) n FROM announcement_recipients WHERE announcement_id=?').get(result.annId) as any).n;
const held = (db.prepare("SELECT COUNT(*) n FROM held_notifications hn JOIN users u ON u.id=hn.user_id WHERE u.username LIKE 'h200.%' AND hn.released_at IS NULL").get() as any).n;
const groups = db.prepare("SELECT title, (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id=c.id) n FROM conversations c WHERE created_by=? AND kind='group' AND title LIKE '% (TEST)'").all(alex.id) as any[];

console.log(JSON.stringify({
  ok: true,
  workspace: WS_NAME,
  workspaceId: result.wsId,
  owner: { id: alex.id, username: alex.username, displayName: alex.display_name, plan: 'company' },
  members: result.memberCount,
  recipients: recips,
  acked,
  pending,
  heldReminders: held,
  groups,
  backup: backupPath,
}, null, 2));
