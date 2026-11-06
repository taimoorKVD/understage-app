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

function withSearch(pathname: string, search: string): string {
  const path = (pathname.startsWith('/') ? pathname : `/${pathname}`) || '/';
  if (!search || search === '?') return path;
  return `${path}${search.startsWith('?') ? search : `?${search}`}`;
}

/**
 * Rewrite a raw Linking / payload-url string into an Expo Router path.
 * Custom-scheme URLs like `understage://invite/TOKEN` are parsed with the token as
 * the hostname (`invite`) plus `/TOKEN`, which otherwise fails to produce an
 * initial navigation state. Dev-client launch URLs are sent to `/`.
 * Non-invite query strings (orb menu, workspace segment) are preserved.
 */
export function normalizeUnderstageDeepLink(path: string): string {
  const raw = String(path || '').trim();
  if (!raw) return '/';

  const token = tokenFromInviteUrl(raw) || tokenFromInviteUrl(decodeSafely(raw));
  if (token) return `/invite/${token}`;

  if (DEV_CLIENT_RE.test(raw)) return '/';

  if (raw.startsWith('/')) {
    const q = raw.indexOf('?');
    const clean = (q === -1 ? raw : raw.slice(0, q)) || '/';
    const search = q === -1 ? '' : raw.slice(q);
    return withSearch(clean.startsWith('/') ? clean : `/${clean}`, search);
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
      if (pathname === '/' || !pathname) return withSearch('/', u.search || '');
      return withSearch(pathname.startsWith('/') ? pathname : `/${pathname}`, u.search || '');
    }
  } catch { /* fall through */ }

  if (/^invite\/[A-Za-z0-9._-]+/.test(raw)) return `/${raw.split('?')[0]}`;
  return '/';
}
