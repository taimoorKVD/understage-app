import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { X509Certificate, verify as cryptoVerify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_IAP_BUNDLE_ID, PRODUCT_TO_PLAN as SHARED_PRODUCT_TO_PLAN, planFromProductId as sharedPlanFromProductId } from '../../shared/iap-products.js';

export const DEFAULT_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || DEFAULT_IAP_BUNDLE_ID;

export const PRODUCT_TO_PLAN: Record<string, 'production' | 'company'> = { ...SHARED_PRODUCT_TO_PLAN };

export type AppleTransaction = {
  transactionId: string;
  originalTransactionId?: string;
  bundleId: string;
  productId: string;
  purchaseDate?: number;
  expiresDate?: number;
  environment?: string;
  type?: string;
};

export type VerifyFailure = {
  ok: false;
  code: 'INVALID_JWS' | 'UNTRUSTED_CHAIN' | 'BAD_SIGNATURE' | 'EXPIRED_CERT' | 'BUNDLE_MISMATCH' | 'INVALID_PAYLOAD';
  error: string;
};
export type VerifySuccess = { ok: true; transaction: AppleTransaction };
export type VerifyResult = VerifySuccess | VerifyFailure;

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function splitPemBundle(pem: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return blocks || [];
}

/** Load PEM roots from env (`APPLE_ROOT_CA_PEM`, `APPLE_IAP_ROOTS_DIR`) and, when `IAP_VERIFY_ENABLED=1`, bundled Apple roots. */
export function loadTrustedRootPems(): string[] {
  const pems: string[] = [];
  if (process.env.APPLE_ROOT_CA_PEM) pems.push(...splitPemBundle(process.env.APPLE_ROOT_CA_PEM));
  const dir = process.env.APPLE_IAP_ROOTS_DIR;
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/\.(pem|crt|cer|cert)$/i.test(name)) continue;
      const raw = readFileSync(path.join(dir, name));
      const text = raw.toString('utf8');
      if (text.includes('BEGIN CERTIFICATE')) pems.push(...splitPemBundle(text));
      else pems.push(new X509Certificate(raw).toString());
    }
  }
  if (process.env.IAP_VERIFY_ENABLED === '1') {
    const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../certs');
    if (existsSync(bundledDir)) {
      for (const name of readdirSync(bundledDir)) {
        if (!/apple/i.test(name) || !/\.(pem|crt)$/i.test(name)) continue;
        pems.push(...splitPemBundle(readFileSync(path.join(bundledDir, name), 'utf8')));
      }
    }
  }
  return pems;
}

export function iapVerificationReady(rootPems = loadTrustedRootPems()): boolean {
  // Local chain fixtures are an explicit development-only override, never a production trust root.
  if (process.env.NODE_ENV === 'production') return process.env.IAP_VERIFY_ENABLED === '1' && rootPems.length > 0;
  if (process.env.IAP_VERIFY_ENABLED === '0') return false;
  return rootPems.length > 0;
}

function parseJws(jws: string): { header: any; payload: any; signingInput: Buffer; signature: Buffer } | null {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    return {
      header,
      payload,
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
      signature: b64urlToBuf(parts[2]),
    };
  } catch {
    return null;
  }
}

function certFromX5c(b64: string): X509Certificate {
  return new X509Certificate(Buffer.from(b64, 'base64'));
}

function fingerprintsEqual(a: X509Certificate, b: X509Certificate): boolean {
  return a.fingerprint256 === b.fingerprint256;
}

function certInWindow(cert: X509Certificate, now: Date): boolean {
  return new Date(cert.validFrom) <= now && now <= new Date(cert.validTo);
}

function verifyChain(certs: X509Certificate[], roots: X509Certificate[], now: Date): VerifyFailure | null {
  if (!certs.length) return { ok: false, code: 'UNTRUSTED_CHAIN', error: 'Missing x5c certificate chain' };
  for (const c of certs) {
    if (!certInWindow(c, now)) return { ok: false, code: 'EXPIRED_CERT', error: 'A certificate in the x5c chain is outside its validity window' };
  }
  for (const r of roots) {
    if (!certInWindow(r, now)) return { ok: false, code: 'EXPIRED_CERT', error: 'A configured trusted root is outside its validity window' };
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      return { ok: false, code: 'UNTRUSTED_CHAIN', error: `Certificate ${i} was not signed by the next certificate in x5c` };
    }
  }
  const last = certs[certs.length - 1];
  const trusted = roots.some(root => fingerprintsEqual(last, root) || last.verify(root.publicKey));
  if (!trusted) return { ok: false, code: 'UNTRUSTED_CHAIN', error: 'Chain does not terminate at a trusted root' };
  return null;
}

export function verifySignedTransaction(
  jws: string,
  opts: { roots: Array<X509Certificate | string>; now?: number; expectedBundleId?: string },
): VerifyResult {
  if (!opts.roots.length) return { ok: false, code: 'UNTRUSTED_CHAIN', error: 'No trusted roots configured' };
  const roots = opts.roots.map(r => (typeof r === 'string' ? new X509Certificate(r) : r));
  const parsed = parseJws(jws);
  if (!parsed) return { ok: false, code: 'INVALID_JWS', error: 'Malformed JWS' };
  if (parsed.header.alg !== 'ES256') return { ok: false, code: 'INVALID_JWS', error: 'Unsupported JWS alg (expected ES256)' };
  const x5c = parsed.header.x5c;
  if (!Array.isArray(x5c) || !x5c.length) return { ok: false, code: 'UNTRUSTED_CHAIN', error: 'Missing x5c certificate chain' };
  let certs: X509Certificate[];
  try { certs = x5c.map((c: string) => certFromX5c(c)); } catch {
    return { ok: false, code: 'UNTRUSTED_CHAIN', error: 'Invalid x5c certificate' };
  }
  const chainErr = verifyChain(certs, roots, new Date(opts.now ?? Date.now()));
  if (chainErr) return chainErr;
  const okSig = cryptoVerify('SHA256', parsed.signingInput, { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' }, parsed.signature);
  if (!okSig) return { ok: false, code: 'BAD_SIGNATURE', error: 'JWS signature does not match the leaf certificate' };
  const payload = parsed.payload;
  if (!payload || typeof payload.transactionId !== 'string' || typeof payload.bundleId !== 'string' || typeof payload.productId !== 'string') {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Transaction payload missing transactionId, bundleId, or productId' };
  }
  if (opts.expectedBundleId && payload.bundleId !== opts.expectedBundleId) {
    return { ok: false, code: 'BUNDLE_MISMATCH', error: 'bundleId does not match this app' };
  }
  return {
    ok: true,
    transaction: {
      transactionId: payload.transactionId,
      originalTransactionId: typeof payload.originalTransactionId === 'string' ? payload.originalTransactionId : undefined,
      bundleId: payload.bundleId,
      productId: payload.productId,
      purchaseDate: typeof payload.purchaseDate === 'number' ? payload.purchaseDate : undefined,
      expiresDate: typeof payload.expiresDate === 'number' ? payload.expiresDate : undefined,
      environment: typeof payload.environment === 'string' ? payload.environment : undefined,
      type: typeof payload.type === 'string' ? payload.type : undefined,
    },
  };
}

export function planFromProductId(productId: string): 'production' | 'company' | null {
  return sharedPlanFromProductId(productId);
}
