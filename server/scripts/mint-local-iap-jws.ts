/**
 * Mint a local sandbox App Store–shaped transaction JWS against a throwaway P-256
 * root/intermediate/leaf. No Apple account, App Store Connect, or paid credentials.
 *
 * Usage:
 *   npx tsx scripts/mint-local-iap-jws.ts [--plan production|company] [--out dir]
 *
 * Prints JSON with { rootPem, signedTransaction, transactionId, productId, planId }.
 * Point the server at the root with APPLE_ROOT_CA_PEM="$(jq -r .rootPem out.json)" to
 * exercise POST /subscriptions/verify without a real StoreKit purchase.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { IAP_PRODUCTS, DEFAULT_IAP_BUNDLE_ID, type PaidPlanId } from '../../shared/iap-products';

function run(dir: string, args: string[]) {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r;
}

function generateChain(dir: string) {
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  run(dir, ['req', '-new', '-x509', '-key', 'root.key', '-out', 'root.crt', '-days', '365', '-subj', '/CN=Understage Local IAP Root']);
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'int.key']);
  run(dir, ['req', '-new', '-key', 'int.key', '-out', 'int.csr', '-subj', '/CN=Understage Local IAP Intermediate']);
  run(dir, ['x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.crt', '-days', '365']);
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  run(dir, ['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Understage Local IAP Leaf']);
  run(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '365']);
  const derB64 = (name: string) => {
    const r = spawnSync('openssl', ['x509', '-in', name, '-outform', 'DER'], { cwd: dir });
    if (r.status !== 0) throw new Error(String(r.stderr));
    return Buffer.from(r.stdout).toString('base64');
  };
  return {
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

function parseArgs(argv: string[]) {
  let plan: PaidPlanId = 'company';
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' && argv[i + 1]) { plan = argv[++i] as PaidPlanId; }
    else if (argv[i] === '--out' && argv[i + 1]) { out = argv[++i]; }
  }
  if (plan !== 'production' && plan !== 'company') throw new Error('--plan must be production|company');
  return { plan, out };
}

const { plan, out } = parseArgs(process.argv.slice(2));
const product = IAP_PRODUCTS[plan];
const dir = mkdtempSync(join(tmpdir(), 'understage-iap-mint-'));
try {
  const chain = generateChain(dir);
  const transactionId = `local-${Date.now()}`;
  const payload = {
    transactionId,
    originalTransactionId: transactionId,
    bundleId: process.env.APPLE_BUNDLE_ID || DEFAULT_IAP_BUNDLE_ID,
    productId: product.productId,
    purchaseDate: Date.now() - 60_000,
    expiresDate: Date.now() + 14 * 86_400_000,
    environment: 'Xcode',
    type: 'Auto-Renewable Subscription',
  };
  const signedTransaction = signJws(payload, chain.leafKey, chain.x5c);
  const result = {
    planId: plan,
    productId: product.productId,
    transactionId,
    signedTransaction,
    rootPem: chain.rootPem,
    note: 'Local stub only. Set APPLE_ROOT_CA_PEM to rootPem before POST /subscriptions/verify. Not an Apple-signed Sandbox JWS.',
  };
  const text = JSON.stringify(result, null, 2);
  if (out) {
    writeFileSync(out, text);
    console.error(`wrote ${out}`);
  }
  console.log(text);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
