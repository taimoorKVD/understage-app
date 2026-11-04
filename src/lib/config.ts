import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; socketUrl?: string };

/** In dev, derive the Mac's LAN IP from the Metro host (e.g. "192.168.1.20:8081") so a real iPhone can reach the API on :4000. */
function devHostUrl(): string | undefined {
  if (!__DEV__) return undefined;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host && host !== 'localhost' && host !== '127.0.0.1' ? `http://${host}:4000` : undefined;
}

const strip = (u: string) => u.replace(/\/$/, '');

/**
 * API base URL, in priority order: EXPO_PUBLIC_API_URL (.env) → app.config extra.apiUrl → Metro host IP (dev only)
 * → http://localhost:4000 (works only in the iOS Simulator on the same Mac).
 */
export const API_URL: string = strip(process.env.EXPO_PUBLIC_API_URL || extra.apiUrl || devHostUrl() || 'http://localhost:4000');

/** Socket.IO URL: EXPO_PUBLIC_SOCKET_URL → extra.socketUrl → API_URL. */
export const SOCKET_URL: string = strip(process.env.EXPO_PUBLIC_SOCKET_URL || extra.socketUrl || API_URL);
