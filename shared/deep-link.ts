/** Deep-link helpers shared by expo-router +native-intent, the QR scanner, and tests. */
const INVITE_TOKEN_RE = /(?:^|[\/])invite\/([A-Za-z0-9._-]+)/i;
const DEV_CLIENT_RE = /expo-development-client|exps?:\/\//i;

export function tokenFromInviteUrl(data: string): string | null {
  const m = String(data || '').match(INVITE_TOKEN_RE);
  return m?.[1] ?? null;
}

function decodeSafely(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Rewrite a raw Linking / payload-url string into an Expo Router path.
 * Custom-scheme URLs like `understage://invite/TOKEN` are parsed with the token as
 * the hostname (`invite`) plus `/TOKEN`, which otherwise fails to produce an
 * initial navigation state. Dev-client launch URLs are sent to `/`.
 */
export function normalizeUnderstageDeepLink(path: string): string {
  const raw = String(path || '').trim();
  if (!raw) return '/';

  const token = tokenFromInviteUrl(raw) || tokenFromInviteUrl(decodeSafely(raw));
  if (token) return `/invite/${token}`;

  if (DEV_CLIENT_RE.test(raw)) return '/';

  if (raw.startsWith('/')) {
    const clean = raw.split('?')[0] || '/';
    return clean.startsWith('/') ? clean : `/${clean}`;
  }

  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      const u = new URL(raw);
      const host = u.hostname || u.host || '';
      let pathname = u.pathname || '/';
      if (host && host !== '--' && !/^expo/i.test(host) && host !== 'localhost') {
        pathname = `/${host}${pathname === '/' ? '' : pathname}`;
      }
      pathname = pathname.replace(/\/+/g, '/') || '/';
      const nested = tokenFromInviteUrl(pathname);
      if (nested) return `/invite/${nested}`;
      if (pathname === '/' || !pathname) return '/';
      return pathname.startsWith('/') ? pathname : `/${pathname}`;
    }
  } catch { /* fall through */ }

  if (/^invite\/[A-Za-z0-9._-]+/.test(raw)) return `/${raw.split('?')[0]}`;
  return '/';
}
