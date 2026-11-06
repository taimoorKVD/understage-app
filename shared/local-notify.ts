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
