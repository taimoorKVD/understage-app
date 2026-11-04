import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

/** Registers an Expo push token with the server. Needs a physical device + an EAS projectId (see README). */
export async function registerPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!Device.isDevice) return { ok: false, reason: 'Push needs a physical iPhone' };
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, reason: 'Notifications are off in iOS Settings' };
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { ok: false, reason: 'No EAS projectId configured' };
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api('POST', '/push/tokens', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  return { ok: true };
}

export function useNotificationRouting() {
  const last = Notifications.useLastNotificationResponse();
  const id = last?.notification.request.identifier;
  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const d = last.notification.request.content.data as any;
    if (d?.conversationId) router.push(`/chat/${d.conversationId}`);
    else if (d?.workspaceId) router.push(`/workspace/${d.workspaceId}`);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- route once per notification identifier; `last` is a new object each render
}
