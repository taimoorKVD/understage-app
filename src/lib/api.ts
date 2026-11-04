import { API_URL } from './config';
import { secure, type Session } from './secure';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export class NetworkError extends Error {}

let session: Session | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: () => void = () => {};
export const apiSession = {
  set(s: Session | null) { session = s; }, get: () => session, onSignedOut(cb: () => void) { onSignedOut = cb; },
};

async function refresh(): Promise<boolean> {
  if (!session) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: session!.refreshToken }) });
      if (!r.ok) { if (r.status === 401) { session = null; await secure.clearSession(); onSignedOut(); } return false; }
      const j = await r.json();
      session = { ...session!, accessToken: j.accessToken, refreshToken: j.refreshToken };
      await secure.setSession(session);
      return true;
    } catch { return false; } finally { setTimeout(() => (refreshing = null), 0); }
  })();
  return refreshing;
}

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new NetworkError(`Can't reach Understage (${API_URL}). Check your connection.`);
  }
  if (res.status === 401 && session && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(method, path, body, true);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error || 'ERROR', json.message || friendly(json.error) || `Request failed (${res.status})`);
  return json as T;
}
const friendly = (c?: string) => ({ BLOCKED: 'You can’t contact this person', NOT_FOUND: 'Not found', UNAUTHORIZED: 'Please sign in again', INTERNAL: 'Something went wrong on our side' } as Record<string, string>)[c || ''];
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
