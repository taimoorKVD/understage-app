import { describe, it, expect } from 'vitest';
import {
  conversationSupportsMls, decodeMlsApplication, encodeMlsApplication,
  isMlsProtocol, isMlsReady, mlsFounderId, mlsGroupOverLimit, naclGroupOverLimit,
  E2EE_NACL_GROUP_LIMIT, MLS_GROUP_LIMIT, MLS_PAYLOAD_NONCE, MLS_PROTOCOL, MLS_SHARED_RECIPIENT,
} from '../../shared/mls-protocol';

describe('MLS dual-stack helpers', () => {
  it('keeps nacl as the default path when the directory is off', () => {
    const members = [
      { id: 'a', mlsReady: true },
      { id: 'b', mlsReady: true },
    ];
    expect(conversationSupportsMls(false, members)).toBe(false);
    expect(conversationSupportsMls(true, members)).toBe(true);
  });

  it('requires every member to be MLS-ready before selecting the v2 path', () => {
    const mixed = [
      { id: 'a', mlsSignaturePublicKey: 'ak' },
      { id: 'b', mlsReady: false, mlsSignaturePublicKey: null },
    ];
    expect(conversationSupportsMls(true, mixed)).toBe(false);
    expect(isMlsReady(mixed[0])).toBe(true);
    expect(isMlsReady(mixed[1])).toBe(false);
  });

  it('picks a deterministic founder so only one client creates the group', () => {
    expect(mlsFounderId(['u_b', 'u_a', 'u_c'])).toBe('u_a');
    expect(mlsFounderId(['u_c', 'u_a', 'u_b'])).toBe('u_a');
  });

  it('keeps the nacl cap at 50 and the MLS cap at 200', () => {
    expect(naclGroupOverLimit(50)).toBe(false);
    expect(naclGroupOverLimit(51)).toBe(true);
    expect(mlsGroupOverLimit(200)).toBe(false);
    expect(mlsGroupOverLimit(201)).toBe(true);
    expect(E2EE_NACL_GROUP_LIMIT).toBe(50);
    expect(MLS_GROUP_LIMIT).toBe(200);
  });

  it('round-trips an application payload (text or attachment key) as JSON', () => {
    const text = { v: 1, type: 'text', text: 'stand by', sentAt: 1 };
    expect(decodeMlsApplication(encodeMlsApplication(text))).toEqual(text);
    const image = {
      v: 1, type: 'image',
      attachment: { id: 'att_1', key: 'file-key', nonce: 'file-nonce', mime: 'image/jpeg', name: 'cue.jpg', size: 12 },
      sentAt: 2,
    };
    expect(decodeMlsApplication(encodeMlsApplication(image))).toEqual(image);
    expect(decodeMlsApplication('not-json')).toBeNull();
  });

  it('recognises MLS protocol markers without treating nacl payloads as MLS', () => {
    expect(isMlsProtocol(MLS_PROTOCOL)).toBe(true);
    expect(isMlsProtocol(MLS_PAYLOAD_NONCE)).toBe(true);
    expect(isMlsProtocol('nacl')).toBe(false);
    expect(MLS_SHARED_RECIPIENT).toBe('*');
  });
});
