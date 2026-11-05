import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { verifySignedTransaction, planFromProductId } from '../src/iap';
import { setup, signup, H } from './helpers';

function run(dir: string, args: string[]) {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r;
}

function generateChain() {
  const dir = mkdtempSync(join(tmpdir(), 'understage-iap-'));
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  run(dir, ['req', '-new', '-x509', '-key', 'root.key', '-out', 'root.crt', '-days', '365', '-subj', '/CN=Understage Test Apple Root']);
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'int.key']);
  run(dir, ['req', '-new', '-key', 'int.key', '-out', 'int.csr', '-subj', '/CN=Understage Test Apple Intermediate']);
  run(dir, ['x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.crt', '-days', '365']);
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  run(dir, ['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Understage Test Apple Leaf']);
  run(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '365']);
  const derB64 = (name: string) => {
    const r = spawnSync('openssl', ['x509', '-in', name, '-outform', 'DER'], { cwd: dir });
    if (r.status !== 0) throw new Error(String(r.stderr));
    return Buffer.from(r.stdout).toString('base64');
  };
  return {
    dir,
    rootPem: readFileSync(join(dir, 'root.crt'), 'utf8'),
    leafKey: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    x5c: [derB64('leaf.crt'), derB64('int.crt')],
  };
}

function signJws(payload: object, leafKeyPem: string, x5c: string[]) {
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${enc({ alg: 'ES256', x5c })}.${enc(payload)}`;
  const sig = cryptoSign('SHA256', Buffer.from(input), { key: createPrivateKey(leafKeyPem), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const sampleTx = (over: Record<string, unknown> = {}) => ({
  transactionId: '1000000123456789',
  originalTransactionId: '1000000123456789',
  bundleId: 'com.kvmac.understage',
  productId: 'com.understage.company.monthly',
  purchaseDate: Date.now() - 60_000,
  expiresDate: Date.now() + 30 * 86_400_000,
  environment: 'Sandbox',
  type: 'Auto-Renewable Subscription',
  ...over,
});

describe('App Store JWS verification', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  it('accepts a JWS signed by a locally generated chain that terminates at the test root', () => {
    const chain = generateChain(); dirs.push(chain.dir);
    const jws = signJws(sampleTx(), chain.leafKey, chain.x5c);
    const result = verifySignedTransaction(jws, { roots: [chain.rootPem], expectedBundleId: 'com.kvmac.understage' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.productId).toBe('com.understage.company.monthly');
      expect(result.transaction.transactionId).toBe('1000000123456789');
      expect(planFromProductId(result.transaction.productId)).toBe('company');
    }
  });

  it('rejects a JWS whose chain does not terminate at the configured root', () => {
    const good = generateChain(); dirs.push(good.dir);
    const other = generateChain(); dirs.push(other.dir);
    const jws = signJws(sampleTx(), good.leafKey, good.x5c);
    const result = verifySignedTransaction(jws, { roots: [other.rootPem] });
    expect(result).toMatchObject({ ok: false, code: 'UNTRUSTED_CHAIN' });
  });

  it('rejects a tampered payload and a mismatched bundleId', () => {
    const chain = generateChain(); dirs.push(chain.dir);
    const jws = signJws(sampleTx(), chain.leafKey, chain.x5c);
    const parts = jws.split('.');
    const badPayload = Buffer.from(JSON.stringify(sampleTx({ productId: 'com.understage.production.monthly' }))).toString('base64url');
    const tampered = verifySignedTransaction(`${parts[0]}.${badPayload}.${parts[2]}`, { roots: [chain.rootPem] });
    expect(tampered).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    const mismatch = verifySignedTransaction(jws, { roots: [chain.rootPem], expectedBundleId: 'com.other.app' });
    expect(mismatch).toMatchObject({ ok: false, code: 'BUNDLE_MISMATCH' });
    expect(verifySignedTransaction('not-a-jws', { roots: [chain.rootPem] })).toMatchObject({ ok: false, code: 'INVALID_JWS' });
  });
});

describe('POST /subscriptions/verify', () => {
  const prevPem = process.env.APPLE_ROOT_CA_PEM;
  const prevEnabled = process.env.IAP_VERIFY_ENABLED;
  afterEach(() => {
    if (prevPem === undefined) delete process.env.APPLE_ROOT_CA_PEM; else process.env.APPLE_ROOT_CA_PEM = prevPem;
    if (prevEnabled === undefined) delete process.env.IAP_VERIFY_ENABLED; else process.env.IAP_VERIFY_ENABLED = prevEnabled;
  });

  it('stays disabled without trusted roots and never grants from a raw transactionId or dev flag', async () => {
    delete process.env.APPLE_ROOT_CA_PEM;
    delete process.env.IAP_VERIFY_ENABLED;
    const t = setup();
    const a = await signup(t, 'iap.disabled');
    const noCfg = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(a), payload: { planId: 'company', transactionId: 'x' } });
    expect(noCfg.statusCode).toBe(501);
    expect(noCfg.json().error).toBe('IAP_NOT_CONFIGURED');
    process.env.SUBSCRIPTIONS_DEV = '1';
    const bypass = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(a), payload: { planId: 'company', transactionId: 'x', dev: true } });
    expect(bypass.statusCode).toBe(501);
    delete process.env.SUBSCRIPTIONS_DEV;
    const me = (await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(a) })).json();
    expect(me.plan.id).toBe('free');
    expect(me.status === 'active' || me.status === 'trial' ? me.plan.id : me.plan.id).toBe('free');
  });

  it('grants a matching plan only after a trusted JWS verifies, and refuses expired or unknown products', async () => {
    const chain = generateChain();
    process.env.APPLE_ROOT_CA_PEM = chain.rootPem;
    try {
      const t = setup();
      const a = await signup(t, 'iap.ok');
      const unsigned = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(a), payload: { planId: 'company', transactionId: 'x' } });
      expect(unsigned.statusCode).toBe(400);
      expect(unsigned.json().error).toBe('IAP_UNVERIFIED');
      expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(a) })).json()).plan.id).toBe('free');

      const okJws = signJws(sampleTx(), chain.leafKey, chain.x5c);
      const ok = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(a), payload: { planId: 'company', transactionId: '1000000123456789', signedTransaction: okJws } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, planId: 'company', status: 'active', environment: 'Sandbox' });
      expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(a) })).json()).plan.id).toBe('company');

      const b = await signup(t, 'iap.expired');
      const expiredJws = signJws(sampleTx({ expiresDate: Date.now() - 1000, transactionId: 'exp-1' }), chain.leafKey, chain.x5c);
      const expired = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(b), payload: { signedTransaction: expiredJws } });
      expect(expired.statusCode).toBe(400);
      expect(expired.json().error).toBe('IAP_EXPIRED');
      expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(b) })).json()).plan.id).toBe('free');

      const c = await signup(t, 'iap.unknown');
      const unknownJws = signJws(sampleTx({ productId: 'com.other.sku', transactionId: 'unk-1' }), chain.leafKey, chain.x5c);
      const unknown = await t.app.inject({ method: 'POST', url: '/subscriptions/verify', headers: H(c), payload: { signedTransaction: unknownJws } });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toBe('IAP_UNVERIFIED');
      expect(((await t.app.inject({ method: 'GET', url: '/subscriptions/me', headers: H(c) })).json()).plan.id).toBe('free');
    } finally {
      rmSync(chain.dir, { recursive: true, force: true });
    }
  });
});
