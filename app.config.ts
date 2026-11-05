import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Extends app.json. API/socket URLs come from .env (EXPO_PUBLIC_API_URL / EXPO_PUBLIC_SOCKET_URL).
 * IOS_BUNDLE_ID (optional, in .env) overrides ios.bundleIdentifier — use a unique id such as
 * com.yourname.understage if Xcode signing with a free Apple ID fails. Re-run `npx expo prebuild` after changing it.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.IOS_BUNDLE_ID || config.ios?.bundleIdentifier,
  },
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL || undefined,
    socketUrl: process.env.EXPO_PUBLIC_SOCKET_URL || process.env.EXPO_PUBLIC_API_URL || undefined,
  },
});
