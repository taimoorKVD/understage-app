import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
type NotificationTestGlobals = typeof globalThis & { __understageLocalNotifOff?: () => void };
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(async () => 'local-1'),
  cancel: vi.fn(async () => undefined),
  dismiss: vi.fn(async () => undefined),
  permissionsGranted: true,
  listeners: new Map<string, Set<(data: any) => void>>(),
  me: { id: 'me', quietHours: false },
  conversations: {},
  workspaces: [],
}));
vi.stubGlobal('__DEV__', true);

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, MAX: 5 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getPermissionsAsync: vi.fn(async () => ({ status: mocks.permissionsGranted ? 'granted' : 'denied' })),
  requestPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  setNotificationHandler: vi.fn(),
  scheduleNotificationAsync: mocks.schedule,
  cancelScheduledNotificationAsync: mocks.cancel,
  dismissNotificationAsync: mocks.dismiss,
  setNotificationChannelAsync: vi.fn(async () => undefined),
  useLastNotificationResponse: vi.fn(() => undefined),
}));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('react-native', () => ({ AppState: { currentState: 'background' }, Platform: { OS: 'ios' } }));
vi.mock('../../../src/lib/api', () => ({ api: vi.fn() }));
vi.mock('../../../src/lib/ui', () => ({ toast: vi.fn() }));
vi.mock('../../../src/lib/secure', () => ({}));
vi.mock('../../../src/lib/crypto', () => ({}));
vi.mock('../../../src/lib/iap', () => ({}));
vi.mock('../../../src/lib/calls', () => ({}));
vi.mock('../../../src/lib/db', () => ({}));
vi.mock('../../../src/lib/mls-session', () => ({}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-modules-core', () => ({ EventEmitter: class {}, requireNativeModule: vi.fn(() => ({})), NativeModule: class {} }));
vi.mock('expo-router', () => ({ registerRootComponent: vi.fn(), router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() } }));
vi.mock('../../../src/store/app', () => {
  const useApp = Object.assign(
    (selector = (state: any) => state) => selector({ me: mocks.me, conversations: mocks.conversations, workspaces: mocks.workspaces }),
    { getState: () => ({ me: mocks.me, conversations: mocks.conversations, workspaces: mocks.workspaces }) },
  );
  return { useApp };
});
vi.mock('../../../src/lib/events', () => ({ bus: {
  on: (name: string, fn: (data: any) => void) => {
    const listeners = mocks.listeners.get(name) ?? new Set();
    listeners.add(fn);
    mocks.listeners.set(name, listeners);
    return () => listeners.delete(fn);
  },
} }));
vi.mock('react', () => ({ useEffect: vi.fn() }));

import { presentLocal, ensureLocalNotifications, cancelLocal, registerPush, wireLocalNotifications } from '../../../src/lib/notifications';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
afterEach(() => {
  (globalThis as NotificationTestGlobals).__understageLocalNotifOff?.();
  mocks.listeners.clear();
  vi.clearAllMocks();
  mocks.permissionsGranted = true;
});
beforeEach(() => { vi.clearAllMocks(); });

describe('local notification runtime (mocked native boundary)', () => {
  it('never schedules when OS permission is denied', async () => {
    mocks.permissionsGranted = false;
    await expect(presentLocal({ title: 'test', body: 'no permission' })).resolves.toBeNull();
    expect(mocks.schedule).not.toHaveBeenCalled();
    const again = await ensureLocalNotifications();
    expect(again).toEqual({ ok: false, status: 'denied' });
  });

  it('schedules iOS time-sensitive local alerts without a remote push token', async () => {
    await expect(presentLocal({ identifier: 'call:1', title: 'Incoming call', body: 'Someone is calling', timeSensitive: true })).resolves.toBe('local-1');
    expect(mocks.schedule).toHaveBeenCalledWith({
      identifier: 'call:1', trigger: null,
      content: { title: 'Incoming call', body: 'Someone is calling', data: {}, sound: true, interruptionLevel: 'timeSensitive' },
    });
    await cancelLocal('call:1');
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('call:1');
    expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith('call:1');
  });

  it('rings and cancels a corresponding incoming call', async () => {
    wireLocalNotifications();
    wireLocalNotifications();
    for (const fn of mocks.listeners.get('call:incoming') ?? []) fn({ callId: 'c1', callerName: 'Alex', from: 'other' });
    await flush();
    expect(mocks.schedule).toHaveBeenCalledOnce();
    expect(mocks.schedule.mock.calls[0][0].content.data).toEqual({ kind: 'call', callId: 'c1', conversationId: undefined });
    for (const fn of mocks.listeners.get('call:ended') ?? []) fn({ callId: 'c1' });
    await flush();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('call:c1');
  });

  it('suppresses own messages and unwires after teardown', async () => {
    wireLocalNotifications();
    for (const fn of mocks.listeners.get('message:new') ?? []) fn({ id: 'm1', conversationId: 'g1', senderId: 'me' });
    await flush();
    expect(mocks.schedule).not.toHaveBeenCalled();
    (globalThis as NotificationTestGlobals).__understageLocalNotifOff();
    expect([...mocks.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it('does not attempt remote token access on a simulator', async () => {
    await expect(registerPush()).resolves.toEqual({ ok: false, reason: 'Push needs a physical iPhone' });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});
