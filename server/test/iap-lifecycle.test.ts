import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, signup, H } from './helpers';
import { iapVerificationReady } from '../src/iap';

function openssl(dir: string, args: string[]) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Local fixture openssl failed: ${result.stderr}`);
  return result;
}
function localChain() {
  const dir = mkdtempSync(join(tmpdir(), 'understage-iap-lifecycle-'));
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'disposable-root.key']);
  openssl(dir, ['req', '-new', '-x509', '-key', 'disposable-root.key', '-out', 'root.crt', '-days', '3650', '-subj', '/CN=Isolated Test Root']);
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'disposable-leaf.key']);
  openssl(dir, ['req', '-new', '-key', 'disposable-leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Isolated Test Leaf']);
  openssl(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.crt', '-CAkey', 'disposable-root.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '3650']);
  const leaf = spawnSync('openssl', ['x509', '-in', 'leaf.crt', '-outform', 'DER'], { cwd: dir });
  if (leaf.status !== 0) throw new Error(String(leaf.stderr));
  return { dir, rootPem: readFileSync(join(dir, 'root.crt'), 'utf8'), leafKey: readFileSync(join(dir, 'disposable-leaf.key'), 'utf8'), leafPem: readFileSync(join(dir, 'leaf.crt'), 'utf8'), x5c: [Buffer.from(leaf.stdout).toString('base64')] };
}
function sign(payload: object, root: ReturnType<typeof localChain>) {
  const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const input = `${encode({ alg: 'ES256', x5c: root.x5c })}.${encode(payload)}`;
  const signature = cryptoSign('SHA256', input, { key: createPrivateKey(root.leafKey), dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}
const DAY = 30 * 24 * 60 * 60 * 1000;
const fixtureRoot = localChain();
// Certificate creation can cross a second boundary; test from the actual certificate validity.
const NOW = Math.max(Date.parse(new X509Certificate(fixtureRoot.rootPem).validFrom), Date.parse(new X509Certificate(fixtureRoot.leafPem).validFrom)) + 2000;
function transaction(transactionId: string, originalTransactionId: string, expiresDate: number) {
  return { transactionId, originalTransactionId, bundleId: 'com.kvmac.understage', productId: 'com.understage.company.monthly', purchaseDate: NOW - 1000, expiresDate, environment: 'Sandbox', type: 'Auto-Renewable Subscription' };
}
async function verify(t: any, user: any, signedTransaction: string) {
  return t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(user), payload: { signedTransaction } });
}
async function createWorkspace(t: any, user: any) {
  return t.app.inject({ method: 'POST', url: '/workspaces', headers: H(user), payload: { name: 'Isolated Test Production', venue: 'Test Studio', runLabel: 'Fixture', departments: [] } });
}

describe('subscription lifecycle with local cryptographic fixtures only', () => {
  let root: ReturnType<typeof localChain>;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    root = fixtureRoot;
    previous = {
      ROOT: process.env.APPLE_ROOT_CA_PEM,
      ENABLED: process.env.IAP_VERIFY_ENABLED,
      ROOTS: process.env.APPLE_IAP_ROOTS_DIR,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.APPLE_ROOT_CA_PEM = root.rootPem;
    process.env.APPLE_IAP_ROOTS_DIR = ':test-empty:';
    process.env.NODE_ENV = 'test';
    delete process.env.IAP_VERIFY_ENABLED;
  });
  afterAll(() => {
    rmSync(fixtureRoot.dir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({ APPLE_ROOT_CA_PEM: previous.ROOT, IAP_VERIFY_ENABLED: previous.ENABLED, APPLE_IAP_ROOTS_DIR: previous.ROOTS, NODE_ENV: previous.NODE_ENV })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('expires active entitlements at the signed expiry', async () => {
    let now = NOW;
    const t = setup(() => now);
    const user = await signup(t, 'iap-expiry-isolated');
    const first = await verify(t, user, sign(transaction('renew-1', 'family-1', NOW + DAY), root));
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    expect((await createWorkspace(t, user)).statusCode).toBe(200);
    now = NOW + DAY + 1;
    expect((await createWorkspace(t, user)).statusCode).toBe(403);
    expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(user) })).json()).plan.id).toBe('free');
  });

  it('allows idempotent restore, advances same-family renewal, ignores stale snapshots, and rejects another account', async () => {
    const t = setup(() => NOW);
    const a = await signup(t, 'iap-lifecycle-a');
    const b = await signup(t, 'iap-lifecycle-b');
    const first = sign(transaction('renew-1', 'family-1', NOW + DAY), root);
    const renewed = sign(transaction('renew-2', 'family-1', NOW + 2 * DAY), root);
    const accepted = await verify(t, a, first);
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
    expect((await verify(t, a, first)).statusCode).toBe(200);
    expect((await verify(t, a, renewed)).statusCode).toBe(200);
    const current = await verify(t, a, first);
    expect(current.statusCode).toBe(200);
    expect(current.json().renewsAt).toBe(NOW + 2 * DAY);
    const mismatched = sign(transaction('renew-1', 'family-1', NOW + 3 * DAY), root);
    const mismatch = await verify(t, a, mismatched);
    expect(mismatch.statusCode, JSON.stringify(mismatch.json())).toBe(409);
    expect(mismatch.json().error).toBe('IAP_TRANSACTION_MISMATCH');
    const crossAccount = await verify(t, b, first);
    expect(crossAccount.statusCode).toBe(409);
    expect(crossAccount.json().error).toBe('IAP_TRANSACTION_OWNED');
    expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(b) })).json()).plan.id).toBe('free');
  });

  it('requires an explicit expiry and family identity before granting', async () => {
    const t = setup(() => NOW);
    const user = await signup(t, 'iap-fields-isolated');
    const complete = transaction('tx-expiry-required', 'family-requires-expiry', NOW + DAY) as any;
    const noExpiry = await verify(t, user, sign({ ...complete, expiresDate: undefined }, root));
    expect(noExpiry.statusCode, JSON.stringify(noExpiry.json())).toBe(400);
    const noFamily = await verify(t, user, sign({ ...complete, originalTransactionId: undefined }, root));
    expect(noFamily.statusCode, JSON.stringify(noFamily.json())).toBe(400);
    const status = await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(user) });
    expect(status.json().plan.id).toBe('free');
    const accepted = await verify(t, user, sign(complete, root));
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
  });

  it('does not migrate a subscription family to a different account', async () => {
    const t = setup(() => NOW);
    const a = await signup(t, 'iap-family-owner-a');
    const b = await signup(t, 'iap-family-owner-b');
    const first = sign(transaction('shared-family-first', 'shared-family', NOW + DAY), root);
    const renewal = sign(transaction('shared-family-renewal', 'shared-family', NOW + 2 * DAY), root);
    const accepted = await verify(t, a, first);
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
    const crossAccount = await verify(t, b, renewal);
    expect(crossAccount.statusCode, JSON.stringify(crossAccount.json())).toBe(409);
    expect(crossAccount.json().error).toBe('IAP_TRANSACTION_OWNED');
  });
  it('allows same-account family upgrades and repurchase after expiry', async () => {
    const t = setup(() => NOW);
    const user = await signup(t, 'iap-family-isolated');
    const accepted = await verify(t, user, sign(transaction('family-1-renew', 'family-1', NOW + DAY), root));
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
    const switched = await verify(t, user, sign(transaction('family-2-renew', 'family-2', NOW + DAY), root));
    expect(switched.statusCode, JSON.stringify(switched.json())).toBe(200);
    const upgrade = { ...transaction('family-1-upgrade', 'family-1', NOW + DAY), productId: 'com.understage.production.monthly' };
    const upgraded = await verify(t, user, sign(upgrade, root));
    expect(upgraded.statusCode, JSON.stringify(upgraded.json())).toBe(200);
    expect(upgraded.json().planId).toBe('production');
    const expired = setup(() => NOW + 3 * DAY);
    const repurchaser = await signup(expired, 'iap-expired-repurchase');
    expect((await verify(expired, repurchaser, sign(transaction('old-family-renew', 'old-family', NOW + DAY), root))).statusCode).toBe(400);
    expired.ctx.db.prepare("UPDATE users SET plan='company', plan_status='active', plan_renews_at=? WHERE id=?").run(NOW, repurchaser.id);
    expired.ctx.db.prepare("INSERT INTO iap_transactions (transaction_id, user_id, original_transaction_id, product_id, expires_at, environment, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run('old-family-transaction', repurchaser.id, 'old-family', 'com.understage.company.monthly', NOW, 'Sandbox', NOW - 1000);
    const replacement = await verify(expired, repurchaser, sign(transaction('new-family-renew', 'new-family', NOW + 4 * DAY), root));
    expect(replacement.statusCode, JSON.stringify(replacement.json())).toBe(200);
    expect(replacement.json().renewsAt).toBe(NOW + 4 * DAY);
  });

  it('does not enable a local roots directory in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.IAP_VERIFY_ENABLED = '1';
    delete process.env.APPLE_ROOT_CA_PEM;
    process.env.APPLE_IAP_ROOTS_DIR = root.dir;
    expect(iapVerificationReady()).toBe(false);
  });
});
