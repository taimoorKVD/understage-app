import { describe, it, expect } from 'vitest';
import { localNotificationRoute, shouldPresentLocalAlert } from '../../shared/local-notify';

describe('shouldPresentLocalAlert', () => {
  it('skips foreground and self-sent messages', () => {
    expect(shouldPresentLocalAlert({ appState: 'active', kind: 'message' })).toBe(false);
    expect(shouldPresentLocalAlert({ appState: 'background', fromSelf: true, kind: 'message' })).toBe(false);
  });

  it('rings calls even during quiet hours when backgrounded', () => {
    expect(shouldPresentLocalAlert({
      appState: 'background', kind: 'call', quietHours: true, onShift: false,
    })).toBe(true);
  });

  it('holds messages during quiet hours off-shift', () => {
    expect(shouldPresentLocalAlert({
      appState: 'background', kind: 'message', quietHours: true, onShift: false,
    })).toBe(false);
    expect(shouldPresentLocalAlert({
      appState: 'inactive', kind: 'message', quietHours: true, onShift: true,
    })).toBe(true);
  });

  it('shows summary and announcements when backgrounded on-shift', () => {
    expect(shouldPresentLocalAlert({ appState: 'background', kind: 'summary' })).toBe(true);
    expect(shouldPresentLocalAlert({
      appState: 'background', kind: 'announcement', quietHours: false, onShift: true,
    })).toBe(true);
  });
});

describe('localNotificationRoute', () => {
  it('opens the workspace announcement feed with its id encoded in canonical Expo format', () => {
    expect(localNotificationRoute({ kind: 'announcement', workspaceId: 'ws1', announcementId: 'ann1' })).toEqual({
      kind: 'announcement', workspaceId: 'ws1', announcementId: 'ann1',
    });
  });
  it('routes message, calls and summary taps to existing screens', () => {
    expect(localNotificationRoute({ kind: 'message', conversationId: 'c1' })).toEqual({ kind: 'chat', conversationId: 'c1' });
    expect(localNotificationRoute({ kind: 'call', callId: 'call1' })).toEqual({ kind: 'calls' });
    expect(localNotificationRoute({ kind: 'summary' })).toEqual({ kind: 'chats' });
  });
  it('does not route malformed or unrelated payloads', () => {
    expect(localNotificationRoute(null)).toBeNull();
    expect(localNotificationRoute({ kind: 'message', conversationId: 4 })).toBeNull();
    expect(localNotificationRoute({ kind: 'announcement', workspaceId: 'ws1' })).toBeNull();
    expect(localNotificationRoute({ conversationId: '/unexpected' })).toBeNull();
  });
});
