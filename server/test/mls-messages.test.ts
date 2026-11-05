import { describe, it, expect } from 'vitest';
import { setup, signup, H, type TUser } from './helpers';
import { generateIdentity, encryptForRecipients, decryptPayload } from '../../shared/e2ee';
import { keyPackageHashRef } from '../src/mls';
import { MLS_GROUP_LIMIT, MLS_PAYLOAD_NONCE, MLS_SHARED_RECIPIENT } from '../../shared/mls-protocol';

function setupMls() {
  return setup(undefined, { mlsDirectoryEnabled: true });
}

function b64(s: string) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function pkg(label: string, now = Date.now(), lastResort = false) {
  const ciphertext = b64(`kp:${label}:${Math.random().toString(16).slice(2)}`);
  const notBefore = now - 60 * 60 * 1000;
  const notAfter = notBefore + (3 * 28 * 24 * 60 * 60 * 1000);
  return { ciphertext, hashRef: keyPackageHashRef(ciphertext), lastResort, notBefore, notAfter };
}

async function publishReady(t: ReturnType<typeof setup>, user: TUser) {
  const key = generateIdentity().publicKey;
  const cred = await t.app.inject({
    method: 'PUT', url: '/me/mls/credential', headers: H(user),
    payload: { signaturePublicKey: key, credentialIdentity: user.id },
  });
  expect(cred.statusCode).toBe(200);
  const up = await t.app.inject({
    method: 'POST', url: '/me/key-packages', headers: H(user),
    payload: { packages: [pkg(`${user.username}-1`), pkg(`${user.username}-lr`, Date.now(), true)] },
  });
  expect(up.statusCode).toBe(200);
  return key;
}

async function openDirect(t: ReturnType<typeof setup>, a: TUser, b: TUser) {
  const conv = await t.app.inject({
    method: 'POST', url: '/conversations', headers: H(a),
    payload: { kind: 'direct', userId: b.id },
  });
  expect(conv.statusCode).toBe(200);
  return conv.json().conversation.id as string;
}

async function establishMls(t: ReturnType<typeof setup>, founder: TUser, cid: string, welcomes: { recipientId: string; body: string }[] = []) {
  const posted = await t.app.inject({
    method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(founder),
    payload: { epoch: 0, commit: b64('commit-epoch-0'), welcomes },
  });
  expect(posted.statusCode).toBe(200);
  return posted.json() as { epoch: number; commitId: string; groupId: string };
}

describe('MLS application messages (Phase 3)', () => {
  it('stores one v2 ciphertext that every member can fetch', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.msg.a');
    const b = await signup(t, 'mls.msg.b');
    await publishReady(t, a);
    await publishReady(t, b);
    const cid = await openDirect(t, a, b);
    await establishMls(t, a, cid, [{ recipientId: b.id, body: b64('welcome-b') }]);

    const body = b64('mls-app:hello-from-a');
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a),
      payload: { clientId: 'mls-app-0001', protocol: 'mls', epoch: 1, ciphertext: body },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.protocol).toBe('mls');
    expect(sent.json().message.ciphertext).toBe(body);
    expect(sent.json().message.nonce).toBe(MLS_PAYLOAD_NONCE);

    const aliceView = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/messages`, headers: H(a) });
    const bobView = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/messages`, headers: H(b) });
    expect(aliceView.json().messages).toHaveLength(1);
    expect(bobView.json().messages).toHaveLength(1);
    expect(aliceView.json().messages[0].ciphertext).toBe(body);
    expect(bobView.json().messages[0].ciphertext).toBe(body);
    expect(aliceView.json().messages[0].protocol).toBe('mls');
    expect(bobView.json().messages[0].protocol).toBe('mls');

    const rows = t.ctx.db.prepare('SELECT recipient_id, ciphertext FROM message_payloads WHERE message_id=?').all(sent.json().message.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(MLS_SHARED_RECIPIENT);
    expect(rows[0].ciphertext).toBe(body);

    const sync = await t.app.inject({ method: 'GET', url: '/sync?since=0', headers: H(b) });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().messages[0].ciphertext).toBe(body);
    expect(sync.json().messages[0].protocol).toBe('mls');
    expect(t.events.some(e => e.user === b.id && e.event === 'message:new' && e.data.protocol === 'mls')).toBe(true);
  });

  it('does not break the existing nacl 1:1 path while the directory is on', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.nacl.a');
    const b = await signup(t, 'mls.nacl.b');
    const cid = await openDirect(t, a, b);
    const secret = { v: 1 as const, type: 'text' as const, text: 'still nacl', sentAt: Date.now() };
    const payloads = encryptForRecipients(secret, [
      { id: a.id, publicKey: a.id_.publicKey },
      { id: b.id, publicKey: b.id_.publicKey },
    ], a.id_.secretKey);
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a),
      payload: { clientId: 'nacl-keep-0001', payloads },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.protocol).toBe('nacl');
    const listed = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/messages`, headers: H(b) });
    const m = listed.json().messages[0];
    expect(decryptPayload(m.nonce, m.ciphertext, a.id_.publicKey, b.id_.secretKey)).toMatchObject({ text: 'still nacl' });
  });

  it('rejects MLS application messages when the directory flag is off', async () => {
    const t = setup();
    const a = await signup(t, 'mls.off.a');
    const b = await signup(t, 'mls.off.b');
    const cid = await openDirect(t, a, b);
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a),
      payload: { clientId: 'mls-off-0001', protocol: 'mls', ciphertext: b64('nope') },
    });
    expect(sent.statusCode).toBe(404);
    expect(sent.json().error).toBe('MLS_DISABLED');
  });

  it('rejects MLS application messages before a group Commit exists', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.nogroup.a');
    const b = await signup(t, 'mls.nogroup.b');
    const cid = await openDirect(t, a, b);
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a),
      payload: { clientId: 'mls-nogroup-01', protocol: 'mls', ciphertext: b64('early') },
    });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toBe('MLS_GROUP_MISSING');
  });

  it('is idempotent on clientId for MLS just like nacl', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.idem.a');
    const b = await signup(t, 'mls.idem.b');
    const cid = await openDirect(t, a, b);
    await establishMls(t, a, cid);
    const payload = { clientId: 'mls-idem-0001', protocol: 'mls', ciphertext: b64('once') };
    const first = await t.app.inject({ method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a), payload });
    const second = await t.app.inject({ method: 'POST', url: `/conversations/${cid}/messages`, headers: H(a), payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().message.id).toBe(first.json().message.id);
  });

  it('marks users mlsReady after they publish a credential or KeyPackages', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.ready.a');
    const b = await signup(t, 'mls.ready.b');
    await t.app.inject({ method: 'POST', url: '/contacts', headers: H(a), payload: { userId: b.id } });
    const before = await t.app.inject({ method: 'GET', url: `/users/${b.id}`, headers: H(a) });
    expect(before.json().mlsReady).toBe(false);
    await publishReady(t, b);
    const after = await t.app.inject({ method: 'GET', url: `/users/${b.id}`, headers: H(a) });
    expect(after.json().mlsReady).toBe(true);
    expect(after.json().mlsSignaturePublicKey).toBeTruthy();
  });
});

describe('MLS group size vs nacl cap', () => {
  it('still rejects nacl sends over 50 members when the directory is on', async () => {
    const t = setupMls();
    const owner = await signup(t, 'mls.cap.owner');
    grantCompany(t, owner);
    const extras = seedUsers(t, 50, 'mlscap');
    const create = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(owner),
      payload: { kind: 'group', title: 'nacl-50', memberIds: extras },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().conversation.memberCount).toBe(51);
    expect(create.json().conversation.e2eeError).toBe('GROUP_TOO_LARGE_FOR_E2EE');

    const naclSend = await t.app.inject({
      method: 'POST', url: `/conversations/${create.json().conversation.id}/messages`, headers: H(owner),
      payload: { clientId: 'nacl-big-0001', payloads: [{ recipientId: owner.id, nonce: 'n', ciphertext: 'c' }] },
    });
    expect(naclSend.statusCode).toBe(409);
    expect(naclSend.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');
  });

  it('allows an MLS-established group over 50 members and stores one ciphertext', async () => {
    const t = setupMls();
    const owner = await signup(t, 'mls.room.owner');
    const b = await signup(t, 'mls.room.b');
    const c = await signup(t, 'mls.room.c');
    grantCompany(t, owner);
    const extras = seedUsers(t, 52, 'mlsroom');
    const create = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(owner),
      payload: { kind: 'group', title: 'mls-room', memberIds: [b.id, c.id, ...extras] },
    });
    expect(create.statusCode).toBe(200);
    const cid = create.json().conversation.id as string;
    expect(create.json().conversation.memberCount).toBe(55);
    expect(create.json().conversation.e2eeError).toBe('GROUP_TOO_LARGE_FOR_E2EE');

    await establishMls(t, owner, cid, [
      { recipientId: b.id, body: b64('w-b') },
      { recipientId: c.id, body: b64('w-c') },
    ]);

    const refreshed = await t.app.inject({ method: 'GET', url: `/conversations/${cid}`, headers: H(owner) });
    expect(refreshed.json().conversation.e2eeError).toBeNull();
    expect(refreshed.json().conversation.mls.epoch).toBe(1);
    expect(refreshed.json().conversation.memberCount).toBe(55);

    const body = b64('mls-app:one-ciphertext');
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/messages`, headers: H(owner),
      payload: { clientId: 'mls-group-0001', protocol: 'mls', ciphertext: body },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.protocol).toBe('mls');

    for (const member of [b, c]) {
      const view = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/messages`, headers: H(member) });
      expect(view.json().messages[0].ciphertext).toBe(body);
    }
    const stored = t.ctx.db.prepare('SELECT COUNT(*) n FROM message_payloads WHERE message_id=?').get(sent.json().message.id) as any;
    expect(stored.n).toBe(1);
  });

  it('rejects creating a group larger than 200 even with the directory on', async () => {
    const t = setupMls();
    const owner = await signup(t, 'mls.over.owner');
    grantCompany(t, owner);
    const extras = seedUsers(t, 200, 'mlsover');
    const create = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(owner),
      payload: { kind: 'group', title: 'too-big', memberIds: extras },
    });
    expect(create.statusCode).toBe(409);
    expect(create.json().error).toBe('GROUP_TOO_LARGE_FOR_E2EE');
    expect(MLS_GROUP_LIMIT).toBe(200);

    const ok = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(owner),
      payload: { kind: 'group', title: 'just-200', memberIds: extras.slice(0, 199) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().conversation.memberCount).toBe(200);
  });
});

function seedUsers(t: ReturnType<typeof setup>, n: number, prefix: string) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `usr_${prefix}${i}`;
    t.ctx.db.prepare('INSERT INTO users (id, identifier_hash, identifier_kind, display_name, username, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, `h_${prefix}${i}`, 'phone', `${prefix} ${i}`, `${prefix}${i}`, Date.now());
    ids.push(id);
  }
  return ids;
}

function grantCompany(t: ReturnType<typeof setup>, user: TUser) {
  t.ctx.db.prepare("UPDATE users SET plan='company', plan_status='active' WHERE id=?").run(user.id);
}
