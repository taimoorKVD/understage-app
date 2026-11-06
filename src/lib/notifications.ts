import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { router } from 'expo-router';
import { api } from './api';
import { bus } from './events';
import { useApp } from '../store/app';
import { isOnShift } from './time';
import type { ServerMessage } from './types';
import { shouldPresentLocalAlert } from '../../shared/local-notify';
export { shouldPresentLocalAlert } from '../../shared/local-notify';

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
  });
} catch {
  // Simulator / Personal Team builds without push entitlements can throw; local path still works when scheduling succeeds.
}

let wired = false;
let permAsked = false;
let channelsReady = false;

async function ensureAndroidChannels() {
  if (channelsReady || Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Understage',
      importance: AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('calls', {
      name: 'Calls',
      importance: AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 500, 200, 500],
    });
    channelsReady = true;
  } catch {
    // Channel setup is best-effort; scheduling still attempted.
  }
}

/** Request OS permission for local notifications only (no APNs / Expo push token). */
export async function ensureLocalNotifications(): Promise<{ ok: boolean; status: string }> {
  try {
    await ensureAndroidChannels();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && !permAsked) {
      permAsked = true;
      status = (await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      })).status;
    }
    return { ok: status === 'granted', status };
  } catch {
    return { ok: false, status: 'error' };
  }
}

export type LocalNotifInput = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  identifier?: string;
  channelId?: 'default' | 'calls';
  /** iOS time-sensitive for ringing calls. */
  timeSensitive?: boolean;
};

/** Present an immediate local notification. Works without APNs when the app process is alive. */
export async function presentLocal(input: LocalNotifInput): Promise<string | null> {
  try {
    const perm = await ensureLocalNotifications();
    if (!perm.ok) return null;
    await ensureAndroidChannels();
    const content: Notifications.NotificationContentInput = {
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      sound: true,
      ...(Platform.OS === 'android' ? { channelId: input.channelId ?? 'default' } : {}),
      ...(Platform.OS === 'ios' && input.timeSensitive ? { interruptionLevel: 'timeSensitive' as const } : {}),
    };
    return await Notifications.scheduleNotificationAsync({
      content,
      trigger: null,
      ...(input.identifier ? { identifier: input.identifier } : {}),
    });
  } catch {
    return null;
  }
}

export async function cancelLocal(identifier: string) {
  try { await Notifications.cancelScheduledNotificationAsync(identifier); } catch { /* ignore */ }
  try { await Notifications.dismissNotificationAsync(identifier); } catch { /* ignore */ }
}

function callNotifId(callId: string) { return `call:${callId}`; }

function messageTitle(m: ServerMessage): string {
  const conv = useApp.getState().conversations[m.conversationId];
  if (!conv) return 'Understage';
  if (conv.kind === 'group') return conv.title || 'Group';
  const me = useApp.getState().me?.id;
  const peer = conv.members?.find(x => x.id !== me);
  return peer?.displayName || peer?.username || 'Direct message';
}

/**
 * Subscribe once to realtime bus events and surface local OS notifications while the
 * JS process is alive but the UI is not active. Remote APNs/Expo push remains optional
 * (Personal Team has no aps-environment).
 */
export function wireLocalNotifications() {
  if (wired) return;
  wired = true;

  const offs = [
    bus.on('call:incoming', (d: { callId: string; from: string; callerName: string }) => {
      if (!d?.callId) return;
      if (!shouldPresentLocalAlert({ appState: AppState.currentState ?? 'unknown', kind: 'call' })) return;
      void presentLocal({
        identifier: callNotifId(d.callId),
        title: 'Incoming call',
        body: d.callerName ? `${d.callerName} is calling` : 'Someone is calling',
        data: { kind: 'call', callId: d.callId, conversationId: undefined },
        channelId: 'calls',
        timeSensitive: true,
      });
    }),
    bus.on('call:ended', (d: { callId: string }) => { if (d?.callId) void cancelLocal(callNotifId(d.callId)); }),
    bus.on('call:accepted', (d: { callId: string }) => { if (d?.callId) void cancelLocal(callNotifId(d.callId)); }),
    bus.on('call:answered-elsewhere', (d: { callId: string }) => { if (d?.callId) void cancelLocal(callNotifId(d.callId)); }),
    bus.on('message:new', (m: ServerMessage) => {
      if (!m?.conversationId) return;
      const me = useApp.getState().me;
      const fromSelf = !!me?.id && m.senderId === me.id;
      const quiet = !!me?.quietHours;
      const onShift = me ? isOnShift(me.shift, me.timezone, me.quietHours) : true;
      if (!shouldPresentLocalAlert({ appState: AppState.currentState ?? 'unknown', fromSelf, quietHours: quiet, onShift, kind: 'message' })) return;
      void presentLocal({
        title: messageTitle(m),
        body: 'New encrypted message',
        data: { kind: 'message', conversationId: m.conversationId, messageId: m.id },
      });
    }),
    bus.on('announcement:new', (d: { workspaceId?: string; announcementId?: string }) => {
      const me = useApp.getState().me;
      const quiet = !!me?.quietHours;
      const onShift = me ? isOnShift(me.shift, me.timezone, me.quietHours) : true;
      if (!shouldPresentLocalAlert({ appState: AppState.currentState ?? 'unknown', quietHours: quiet, onShift, kind: 'announcement' })) return;
      const ws = useApp.getState().workspaces.find(w => w.id === d?.workspaceId);
      void presentLocal({
        title: ws?.name ? `📣 ${ws.name}` : 'New announcement',
        body: 'Open Understage to read it',
        data: { kind: 'announcement', workspaceId: d?.workspaceId, announcementId: d?.announcementId },
      });
    }),
    bus.on('held:released', (d: { count: number }) => {
      if (!shouldPresentLocalAlert({ appState: AppState.currentState ?? 'unknown', kind: 'summary' })) return;
      const n = d?.count ?? 0;
      if (n <= 0) return;
      void presentLocal({
        title: 'Good morning — your shift has started',
        body: `${n} update${n === 1 ? '' : 's'} held while you were off shift`,
        data: { kind: 'summary' },
      });
    }),
  ];

  const g = globalThis as any;
  g.__understageLocalNotifOff?.();
  g.__understageLocalNotifOff = () => { offs.splice(0).forEach(f => f()); wired = false; };
}

/** Registers an Expo push token with the server. Needs a physical device + EAS projectId + paid APNs. Soft-fails on Personal Team. */
export async function registerPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!Device.isDevice) return { ok: false, reason: 'Push needs a physical iPhone' };
  // Local alerts still work without remote push; request permission first so local path is ready.
  const local = await ensureLocalNotifications();
  if (!local.ok) return { ok: false, reason: 'Notifications are off in iOS Settings' };
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { ok: false, reason: 'No EAS projectId configured' };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api('POST', '/push/tokens', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
    return { ok: true };
  } catch {
    // Personal Team builds lack aps-environment; local notifications remain available.
    return { ok: false, reason: 'Remote push unavailable (no APNs entitlement)' };
  }
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
