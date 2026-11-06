/** App activity state subset shared with React Native's AppStateStatus. */
export type NotifyAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export type LocalAlertKind = 'message' | 'call' | 'summary' | 'announcement';

/**
 * Pure policy for when a live JS process should schedule an OS local notification.
 * Foreground UI (call overlay / in-app banners) covers `active`; quiet hours hold
 * non-call alerts. Remote APNs is intentionally out of scope here.
 */
export function shouldPresentLocalAlert(opts: {
  appState: NotifyAppState | string;
  fromSelf?: boolean;
  quietHours?: boolean;
  onShift?: boolean;
  kind?: LocalAlertKind;
}): boolean {
  if (opts.fromSelf) return false;
  if (opts.appState === 'active') return false;
  if (opts.kind === 'call') return true;
  if (opts.quietHours && opts.onShift === false) return false;
  return true;
}

export type LocalNotificationRoute =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'announcement'; workspaceId: string; announcementId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'calls' }
  | { kind: 'chats' }
  | null;

/** Validate untrusted notification payloads before handing their destination to expo-router. */
export function localNotificationRoute(data: unknown): LocalNotificationRoute {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const callId = typeof d.callId === 'string' && d.callId.length > 0;
  const conversationId = typeof d.conversationId === 'string' && d.conversationId.length > 0;
  const workspaceId = typeof d.workspaceId === 'string' && d.workspaceId.length > 0;
  const announcementId = typeof d.announcementId === 'string' && d.announcementId.length > 0;
  if (d.kind === 'call' && callId) return { kind: 'calls' };
  if (d.kind === 'message' && conversationId) return { kind: 'chat', conversationId: d.conversationId as string };
  if (d.kind === 'announcement' && workspaceId && announcementId) {
    return { kind: 'announcement', workspaceId: d.workspaceId as string, announcementId: d.announcementId as string };
  }
  if (d.kind === 'summary') return { kind: 'chats' };
  return null;
}
