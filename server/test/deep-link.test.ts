import { describe, expect, it } from 'vitest';
import { normalizeUnderstageDeepLink, tokenFromInviteUrl } from '../../shared/deep-link';
import { formatHttpLog, shouldLogHttpRequests } from '../src/http-log';

const TOKEN = 'us1.abcDEF.-xyz_123';

describe('normalizeUnderstageDeepLink', () => {
  it('rewrites custom-scheme invite URLs (host = invite) to /invite/<token>', () => {
    expect(normalizeUnderstageDeepLink(`understage://invite/${TOKEN}`)).toBe(`/invite/${TOKEN}`);
    expect(normalizeUnderstageDeepLink(`understage:///invite/${TOKEN}`)).toBe(`/invite/${TOKEN}`);
    expect(normalizeUnderstageDeepLink(`understage://invite/${TOKEN}?x=1`)).toBe(`/invite/${TOKEN}`);
  });

  it('accepts already-extracted paths and bare invite/<token> strings', () => {
    expect(normalizeUnderstageDeepLink(`/invite/${TOKEN}`)).toBe(`/invite/${TOKEN}`);
    expect(normalizeUnderstageDeepLink(`invite/${TOKEN}`)).toBe(`/invite/${TOKEN}`);
  });

  it('extracts an invite token embedded in a dev-client launch URL', () => {
    const nested = `com.kvmac.understage://expo-development-client/?url=${encodeURIComponent(`understage://invite/${TOKEN}`)}`;
    expect(normalizeUnderstageDeepLink(nested)).toBe(`/invite/${TOKEN}`);
  });

  it('sends expo-development-client and empty paths to / so linking always seeds state', () => {
    expect(normalizeUnderstageDeepLink('com.kvmac.understage://expo-development-client/?url=http://192.168.100.91:8081')).toBe('/');
    expect(normalizeUnderstageDeepLink('exp://192.168.100.91:8081')).toBe('/');
    expect(normalizeUnderstageDeepLink('')).toBe('/');
    expect(normalizeUnderstageDeepLink('understage://')).toBe('/');
  });

  it('tokenFromInviteUrl matches the scanner contract', () => {
    expect(tokenFromInviteUrl(`understage://invite/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromInviteUrl('https://evil.example/not-an-invite')).toBeNull();
  });
});

describe('formatHttpLog', () => {
  it('logs method, path, status and ip and strips query strings', () => {
    expect(formatHttpLog({ method: 'POST', url: '/invites/resolve?token=secret', ip: '192.168.100.35' }, 200))
      .toBe('[http] POST /invites/resolve 200 192.168.100.35');
    expect(formatHttpLog({ method: 'GET', url: '/calls', ip: '127.0.0.1' }, 200))
      .toBe('[http] GET /calls 200 127.0.0.1');
    const line = formatHttpLog({ method: 'POST', url: '/auth/otp/verify?code=999999', ip: '1.2.3.4' }, 200);
    expect(line).not.toMatch(/999999|Bearer|Authorization|token=secret/i);
    expect(line).toBe('[http] POST /auth/otp/verify 200 1.2.3.4');
  });

  it('is off in production and test unless REQUEST_LOG=1', () => {
    expect(shouldLogHttpRequests({ NODE_ENV: 'production' })).toBe(false);
    expect(shouldLogHttpRequests({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldLogHttpRequests({ NODE_ENV: 'test', REQUEST_LOG: '1' })).toBe(true);
    expect(shouldLogHttpRequests({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldLogHttpRequests({ NODE_ENV: 'development', REQUEST_LOG: '0' })).toBe(false);
    expect(shouldLogHttpRequests({})).toBe(true);
  });
});
