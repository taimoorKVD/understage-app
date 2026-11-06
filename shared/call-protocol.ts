/** Wire-level validation shared by the server relay and the app. Payloads stay sealed (nacl.box); the server only checks shape. */

/** Client call ids are UUIDs; tests use short slugs. */
export const isValidCallId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Max sealed signalling box (an SDP offer is ~3–6 KB; base64 + box overhead stays well under this). */
export const MAX_SEALED_SIGNAL_CHARS = 96_000;

/** `{ n, c }` where n is a 24-byte base64 nonce and c a base64 box of bounded size. */
export function isSealedSignal(v: unknown): v is { n: string; c: string } {
  if (!v || typeof v !== 'object') return false;
  const { n, c } = v as any;
  return typeof n === 'string' && n.length === 32 && B64.test(n)
    && typeof c === 'string' && c.length >= 24 && c.length <= MAX_SEALED_SIGNAL_CHARS && B64.test(c);
}
