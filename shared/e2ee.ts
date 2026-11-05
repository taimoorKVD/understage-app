/**
 * Understage E2EE primitives — shared by the app and the server test-suite.
 *
 * Built on TweetNaCl (audited port of NaCl):
 *  - nacl.box  = X25519 key agreement + XSalsa20-Poly1305 authenticated encryption (per recipient)
 *  - nacl.secretbox = XSalsa20-Poly1305 for attachment blobs (random 32-byte key per file)
 *
 * HONEST SCOPE: this is static-key "sealed per recipient" encryption. It is NOT the Signal
 * protocol: there is no double ratchet, no forward secrecy, no post-compromise security,
 * no pre-key bundles. Groups use per-recipient fan-out (one box per member), not sender keys.
 */
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64: b64, decodeBase64: unb64, encodeUTF8, decodeUTF8 } = naclUtil;

export interface Identity { publicKey: string; secretKey: string }
export interface Recipient { id: string; publicKey: string }
export interface Payload { recipientId: string; nonce: string; ciphertext: string }

export type PlainMessage =
  | { v: 1; type: 'text'; text: string; sentAt: number; replyTo?: string; mentions?: { userId: string; username: string }[] }
  | { v: 1; type: 'voice'; attachment: AttachmentRef; durationSec: number; waveform: number[]; sentAt: number }
  | { v: 1; type: 'image'; attachment: AttachmentRef; caption?: string; width?: number; height?: number; sentAt: number }
  | { v: 1; type: 'doc'; attachment: AttachmentRef; sentAt: number }
  | { v: 1; type: 'contact'; userId: string; displayName: string; username: string; sentAt: number }
  | { v: 1; type: 'system'; text: string; sentAt: number };

export interface AttachmentRef { id: string; key: string; nonce: string; mime: string; name: string; size: number }

export function setRandomSource(fill: (n: number) => Uint8Array) {
  nacl.setPRNG((x: Uint8Array, n: number) => { const r = fill(n); for (let i = 0; i < n; i++) x[i] = r[i]; });
}

export function generateIdentity(): Identity {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

export function encryptForRecipients(msg: PlainMessage, recipients: Recipient[], senderSecretKey: string): Payload[] {
  const sk = unb64(senderSecretKey);
  const bytes = decodeUTF8(JSON.stringify(msg));
  return recipients.map(r => {
    if (!r.publicKey) throw new Error(`Recipient ${r.id} has no published key`);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(bytes, nonce, unb64(r.publicKey), sk);
    return { recipientId: r.id, nonce: b64(nonce), ciphertext: b64(ct) };
  });
}

export function decryptPayload(nonce: string, ciphertext: string, senderPublicKey: string, mySecretKey: string): PlainMessage | null {
  try {
    const out = nacl.box.open(unb64(ciphertext), unb64(nonce), unb64(senderPublicKey), unb64(mySecretKey));
    if (!out) return null;
    return JSON.parse(encodeUTF8(out)) as PlainMessage;
  } catch { return null; }
}

/** Encrypt a file. Returns the ciphertext and the key/nonce to put inside the (E2EE) message. */
export function encryptBlob(data: Uint8Array) {
  const key = nacl.randomBytes(nacl.secretbox.keyLength), nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { ciphertext: b64(nacl.secretbox(data, nonce, key)), key: b64(key), nonce: b64(nonce) };
}
export function decryptBlob(ciphertextB64: string, keyB64: string, nonceB64: string): Uint8Array | null {
  return nacl.secretbox.open(unb64(ciphertextB64), unb64(nonceB64), unb64(keyB64));
}

function fingerprint(userId: string, publicKey: string): string {
  let h: Uint8Array = decodeUTF8('understage-safety-v1:' + userId);
  const key = unb64(publicKey);
  for (let i = 0; i < 5200; i++) {
    const buf = new Uint8Array(h.length + key.length); buf.set(h); buf.set(key, h.length);
    h = nacl.hash(buf);
  }
  let s = '';
  for (let i = 0; i < 30; i += 5) {
    const n = h[i] * 2 ** 32 + h[i + 1] * 2 ** 24 + h[i + 2] * 2 ** 16 + h[i + 3] * 2 ** 8 + h[i + 4];
    s += String(n % 100000).padStart(5, '0');
  }
  return s;
}

/** 60-digit safety number (12 blocks of 5), identical on both phones. */
export function safetyNumber(a: { id: string; publicKey: string }, b: { id: string; publicKey: string }): string[] {
  const [x, y] = [a, b].sort((p, q) => (p.id < q.id ? -1 : 1));
  const digits = fingerprint(x.id, x.publicKey) + fingerprint(y.id, y.publicKey);
  return digits.match(/.{5}/g)!;
}


/** 60-digit safety number bound to MLS Ed25519 credentials (same 12-group UX). */
export function mlsSafetyNumber(
  a: { id: string; signaturePublicKey: string },
  b: { id: string; signaturePublicKey: string },
): string[] {
  const [x, y] = [a, b].sort((p, q) => (p.id < q.id ? -1 : 1));
  let h: Uint8Array = decodeUTF8('understage-mls-safety-v1:' + x.id + ':' + x.signaturePublicKey + ':' + y.id + ':' + y.signaturePublicKey);
  h = nacl.hash(h);
  let s = '';
  for (let i = 0; i < 30; i += 5) {
    const n = h[i] * 2 ** 32 + h[i + 1] * 2 ** 24 + h[i + 2] * 2 ** 16 + h[i + 3] * 2 ** 8 + h[i + 4];
    s += String(n % 100000).padStart(5, '0');
  }
  const extra = nacl.hash(h);
  for (let i = 0; i < 30; i += 5) {
    const n = extra[i] * 2 ** 32 + extra[i + 1] * 2 ** 24 + extra[i + 2] * 2 ** 16 + extra[i + 3] * 2 ** 8 + extra[i + 4];
    s += String(n % 100000).padStart(5, '0');
  }
  return s.match(/.{5}/g)!;
}

/** Prefer the MLS number when both sides have published credentials; otherwise the legacy TweetNaCl number. */
export function conversationSafetyNumber(
  a: { id: string; publicKey: string; mlsSignaturePublicKey?: string | null },
  b: { id: string; publicKey: string; mlsSignaturePublicKey?: string | null },
): string[] | null {
  if (a.mlsSignaturePublicKey && b.mlsSignaturePublicKey) {
    return mlsSafetyNumber(
      { id: a.id, signaturePublicKey: a.mlsSignaturePublicKey },
      { id: b.id, signaturePublicKey: b.mlsSignaturePublicKey },
    );
  }
  if (a.publicKey && b.publicKey) return safetyNumber({ id: a.id, publicKey: a.publicKey }, { id: b.id, publicKey: b.publicKey });
  return null;
}

export const base64 = { encode: b64, decode: unb64 };
