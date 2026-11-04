import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Extends app.json. API/socket URLs come from .env (EXPO_PUBLIC_API_URL / EXPO_PUBLIC_SOCKET_URL). */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL || undefined,
    socketUrl: process.env.EXPO_PUBLIC_SOCKET_URL || process.env.EXPO_PUBLIC_API_URL || undefined,
  },
});
