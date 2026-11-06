import { describe, it, expect } from 'vitest';
import { shouldPresentLocalAlert } from '../../shared/local-notify';

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
