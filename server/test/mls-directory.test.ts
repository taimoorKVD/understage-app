import { describe, it, expect } from 'vitest';
import { setup, signup, H, type TUser } from './helpers';
import { generateIdentity } from '../../shared/e2ee';
import { keyPackageHashRef, MLS_MAX_LIFETIME_MS } from '../src/mls';

function setupMls(clock?: () => number) {
  return setup(clock, { mlsDirectoryEnabled: true });
}

function b64(s: string) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function ed25519() {
  return generateIdentity().publicKey; // 32-byte X25519 key is also valid 32-byte length for this directory
}

function lifetime(now: number, extraMs = 0) {
  const notBefore = now - 60 * 60 * 1000;
  const notAfter = notBefore + (3 * 28 * 24 * 60 * 60 * 1000) + extraMs;
  return { notBefore, notAfter };
}

async function publishCredential(t: ReturnType<typeof setup>, user: TUser, key = ed25519()) {
  const r = await t.app.inject({
    method: 'PUT', url: '/me/mls/credential', headers: H(user),
    payload: { signaturePublicKey: key, credentialIdentity: user.id },
  });
  return { r, key };
}

function pkg(label: string, now: number, lastResort = false, life = lifetime(now)) {
  const ciphertext = b64(`kp:${label}:${Math.random().toString(16).slice(2)}`);
  return { ciphertext, hashRef: keyPackageHashRef(ciphertext), lastResort, ...life };
}

describe('MLS directory feature flag (default off)', () => {
  it('keeps the nacl key path working and hides MLS endpoints', async () => {
    const t = setup(); // flag defaults to off
    const a = await signup(t, 'nacl.keep');
    const health = await t.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(health.json().mlsDirectory).toBe(false);

    const cred = await t.app.inject({
      method: 'PUT', url: '/me/mls/credential', headers: H(a),
      payload: { signaturePublicKey: ed25519(), credentialIdentity: a.id },
    });
    expect(cred.statusCode).toBe(404);
    expect(cred.json().error).toBe('MLS_DISABLED');

    const keys = await t.app.inject({
      method: 'PUT', url: '/me/keys', headers: H(a),
      payload: { identityKey: generateIdentity().publicKey },
    });
    expect(keys.statusCode).toBe(200);
    expect(keys.json().ok).toBe(true);

    const me = await t.app.inject({ method: 'GET', url: '/me', headers: H(a) });
    expect(me.json().identityKey).toBeTruthy();
    expect(me.json().mlsSignaturePublicKey).toBeUndefined();
  });
});

describe('MLS AS/DS via HTTP API', () => {
  it('two clients publish credentials and fetch each other on GET /users/:id', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.alice');
    const b = await signup(t, 'mls.bob');
    const aKey = ed25519();
    const bKey = ed25519();
    expect((await publishCredential(t, a, aKey)).r.statusCode).toBe(200);
    expect((await publishCredential(t, b, bKey)).r.statusCode).toBe(200);

    await t.app.inject({ method: 'POST', url: '/contacts', headers: H(a), payload: { userId: b.id } });

    const seen = await t.app.inject({ method: 'GET', url: `/users/${b.id}`, headers: H(a) });
    expect(seen.statusCode).toBe(200);
    expect(seen.json().mlsSignaturePublicKey).toBe(bKey);
    expect(seen.json().mlsCredentialIdentity).toBe(b.id);
    expect(seen.json().identityKey).toBe(b.id_.publicKey);

    const health = await t.app.inject({ method: 'GET', url: '/health' });
    expect(health.json().mlsDirectory).toBe(true);
  });

  it('rejects a credential whose identity is not the caller', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.wrongid');
    const r = await t.app.inject({
      method: 'PUT', url: '/me/mls/credential', headers: H(a),
      payload: { signaturePublicKey: ed25519(), credentialIdentity: 'someone-else' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('IDENTITY_MISMATCH');
  });

  it('issues an ordinary KeyPackage once, then falls back to last-resort without deleting it', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.kpa');
    const b = await signup(t, 'mls.kpb');
    const c = await signup(t, 'mls.kpc');
    const now = Date.now();
    const ordinary = pkg('ordinary-1', now, false);
    const last = pkg('last-resort', now, true);
    const up = await t.app.inject({
      method: 'POST', url: '/me/key-packages', headers: H(a),
      payload: { packages: [ordinary, last] },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().uploaded).toBe(2);

    const first = await t.app.inject({ method: 'GET', url: `/users/${a.id}/key-package`, headers: H(b) });
    expect(first.statusCode).toBe(200);
    expect(first.json().lastResort).toBe(false);
    expect(first.json().hashRef).toBe(ordinary.hashRef);
    expect(first.json().ciphertext).toBe(ordinary.ciphertext);

    const again = await t.app.inject({ method: 'GET', url: `/users/${a.id}/key-package`, headers: H(b) });
    expect(again.statusCode).toBe(200);
    expect(again.json().lastResort).toBe(true);
    expect(again.json().hashRef).toBe(last.hashRef);

    const third = await t.app.inject({ method: 'GET', url: `/users/${a.id}/key-package`, headers: H(c) });
    expect(third.statusCode).toBe(200);
    expect(third.json().lastResort).toBe(true);
    expect(third.json().hashRef).toBe(last.hashRef);

    const status = await t.app.inject({ method: 'GET', url: '/me/key-packages/status', headers: H(a) });
    expect(status.json()).toMatchObject({
      ordinaryRemaining: 0,
      lastResortRemaining: 1,
      lastResortUsed: true,
    });
  });

  it('two concurrent fetchers never receive the same ordinary KeyPackage', async () => {
    const t = setupMls();
    const owner = await signup(t, 'mls.pool');
    const x = await signup(t, 'mls.fetchx');
    const y = await signup(t, 'mls.fetchy');
    const now = Date.now();
    const p1 = pkg('c1', now);
    const p2 = pkg('c2', now);
    const last = pkg('lr', now, true);
    const up = await t.app.inject({
      method: 'POST', url: '/me/key-packages', headers: H(owner),
      payload: { packages: [p1, p2, last] },
    });
    expect(up.statusCode).toBe(200);

    const [r1, r2] = await Promise.all([
      t.app.inject({ method: 'GET', url: `/users/${owner.id}/key-package`, headers: H(x) }),
      t.app.inject({ method: 'GET', url: `/users/${owner.id}/key-package`, headers: H(y) }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().hashRef).not.toBe(r2.json().hashRef);
    const hashes = [r1.json().hashRef, r2.json().hashRef];
    expect(hashes.every((h: string) => [p1.hashRef, p2.hashRef].includes(h))).toBe(true);
    expect(r1.json().lastResort).toBe(false);
    expect(r2.json().lastResort).toBe(false);
  });

  it('rejects expired packages, oversized lifetimes, and hashRef mismatches', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.badpkg');
    const now = Date.now();

    const expired = await t.app.inject({
      method: 'POST', url: '/me/key-packages', headers: H(a),
      payload: { packages: [{ ...pkg('exp', now), notBefore: now - 10_000, notAfter: now - 1 }] },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error).toBe('KEY_PACKAGE_EXPIRED');

    const long = await t.app.inject({
      method: 'POST', url: '/me/key-packages', headers: H(a),
      payload: { packages: [{ ...pkg('long', now), notBefore: now, notAfter: now + MLS_MAX_LIFETIME_MS + 1 }] },
    });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toBe('KEY_PACKAGE_LIFETIME');

    const mismatch = await t.app.inject({
      method: 'POST', url: '/me/key-packages', headers: H(a),
      payload: { packages: [{ ...pkg('mm', now), hashRef: '0'.repeat(64) }] },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('HASH_MISMATCH');
  });

  it('two clients creating a conversation can exchange a Commit + Welcome over HTTP', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.g1');
    const b = await signup(t, 'mls.g2');
    const conv = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(a),
      payload: { kind: 'direct', userId: b.id },
    });
    expect(conv.statusCode).toBe(200);
    const cid = conv.json().conversation.id as string;

    const commit = b64('commit-epoch-0');
    const welcome = b64('welcome-for-b');
    const posted = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(a),
      payload: { epoch: 0, commit, welcomes: [{ recipientId: b.id, body: welcome }] },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ ok: true, epoch: 1 });

    const aliceView = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/mls`, headers: H(a) });
    const bobView = await t.app.inject({ method: 'GET', url: `/conversations/${cid}/mls`, headers: H(b) });
    expect(aliceView.statusCode).toBe(200);
    expect(bobView.statusCode).toBe(200);
    expect(aliceView.json().group.epoch).toBe(1);
    expect(aliceView.json().messages.map((m: any) => m.kind)).toEqual(['commit']);
    expect(bobView.json().messages.map((m: any) => m.kind)).toEqual(['commit', 'welcome']);
    expect(bobView.json().messages[0].body).toBe(commit);
    expect(bobView.json().messages[1].body).toBe(welcome);
    expect(bobView.json().messages[1].commitId).toBe(posted.json().commitId);
    expect(t.events.some(e => e.user === b.id && e.event === 'mls:welcome')).toBe(true);
    expect(t.events.some(e => e.event === 'mls:commit')).toBe(true);
  });

  it('returns 409 EPOCH_CONFLICT when two clients commit concurrently at the same epoch', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.c1');
    const b = await signup(t, 'mls.c2');
    const conv = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(a),
      payload: { kind: 'direct', userId: b.id },
    });
    const cid = conv.json().conversation.id as string;

    const [r1, r2] = await Promise.all([
      t.app.inject({
        method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(a),
        payload: { epoch: 0, commit: b64('commit-from-a') },
      }),
      t.app.inject({
        method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(b),
        payload: { epoch: 0, commit: b64('commit-from-b') },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const ok = r1.statusCode === 200 ? r1 : r2;
    const conflict = r1.statusCode === 409 ? r1 : r2;
    expect(ok.json().epoch).toBe(1);
    expect(conflict.json().error).toBe('EPOCH_CONFLICT');
    expect(conflict.json().epoch).toBe(1);
    expect(conflict.json().winningCommit.body).toBe(ok.statusCode === r1.statusCode ? b64('commit-from-a') : conflict.json().winningCommit.body);
    expect([b64('commit-from-a'), b64('commit-from-b')]).toContain(conflict.json().winningCommit.body);
    expect(conflict.json().winningCommit.id).toBe(ok.json().commitId);
    expect(conflict.json().catchUp).toContain(`/conversations/${cid}/mls?after_epoch=`);

    const retry = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/mls/commits`,
      headers: H(conflict === r1 ? a : b),
      payload: { epoch: 1, commit: b64('commit-retry') },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().epoch).toBe(2);
  });

  it('never returns a Welcome before its Commit, and catch-up honors after_epoch', async () => {
    const t = setupMls();
    const a = await signup(t, 'mls.w1');
    const b = await signup(t, 'mls.w2');
    const c = await signup(t, 'mls.w3');
    const conv = await t.app.inject({
      method: 'POST', url: '/conversations', headers: H(a),
      payload: { kind: 'group', title: 'MLS room', memberIds: [b.id, c.id] },
    });
    const cid = conv.json().conversation.id as string;

    const c0 = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(a),
      payload: { epoch: 0, commit: b64('c0'), welcomes: [{ recipientId: b.id, body: b64('w-b') }] },
    });
    expect(c0.statusCode).toBe(200);
    const c1 = await t.app.inject({
      method: 'POST', url: `/conversations/${cid}/mls/commits`, headers: H(a),
      payload: { epoch: 1, commit: b64('c1'), welcomes: [{ recipientId: c.id, body: b64('w-c') }] },
    });
    expect(c1.statusCode).toBe(200);

    const bobAll = (await t.app.inject({ method: 'GET', url: `/conversations/${cid}/mls`, headers: H(b) })).json().messages;
    const kinds = bobAll.map((m: any) => m.kind);
    expect(kinds.indexOf('commit')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('welcome')).toBeGreaterThan(kinds.indexOf('commit'));
    for (let i = 0; i < bobAll.length; i++) {
      if (bobAll[i].kind === 'welcome') {
        const commit = bobAll.find((m: any) => m.kind === 'commit' && m.id === bobAll[i].commitId);
        expect(commit).toBeTruthy();
        expect(bobAll.indexOf(commit)).toBeLessThan(i);
      }
    }
    expect(bobAll.filter((m: any) => m.kind === 'welcome')).toHaveLength(1);
    expect(bobAll.find((m: any) => m.kind === 'welcome').body).toBe(b64('w-b'));

    const charlie = (await t.app.inject({ method: 'GET', url: `/conversations/${cid}/mls`, headers: H(c) })).json().messages;
    expect(charlie.filter((m: any) => m.kind === 'welcome')).toHaveLength(1);
    expect(charlie.find((m: any) => m.kind === 'welcome').body).toBe(b64('w-c'));
    const firstWelcome = charlie.findIndex((m: any) => m.kind === 'welcome');
    const itsCommit = charlie.findIndex((m: any) => m.id === charlie[firstWelcome].commitId);
    expect(itsCommit).toBeGreaterThanOrEqual(0);
    expect(itsCommit).toBeLessThan(firstWelcome);

    const after0 = (await t.app.inject({
      method: 'GET', url: `/conversations/${cid}/mls?after_epoch=0`, headers: H(c),
    })).json().messages;
    expect(after0.some((m: any) => m.body === b64('c0'))).toBe(false);
    expect(after0.some((m: any) => m.body === b64('c1'))).toBe(true);
    expect(after0.some((m: any) => m.body === b64('w-c'))).toBe(true);
    const w = after0.find((m: any) => m.kind === 'welcome');
    const commit = after0.find((m: any) => m.id === w.commitId);
    expect(after0.indexOf(commit)).toBeLessThan(after0.indexOf(w));
  });
});
