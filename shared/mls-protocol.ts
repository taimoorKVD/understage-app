/**
 * MLS / TweetNaCl dual-stack helpers shared by the app and server tests.
 *
 * Feature-flagged: production send/receive stays on nacl.box unless the
 * directory flag is on and every member is MLS-ready.
 */
export const MLS_PROTOCOL = 'mls' as const;
export const NACL_PROTOCOL = 'nacl' as const;
export type MessageProtocol = typeof MLS_PROTOCOL | typeof NACL_PROTOCOL;

/** Sentinel recipient_id for the single stored MLS application ciphertext. */
export const MLS_SHARED_RECIPIENT = '*';
/** Placeholder nonce stored with an MLS payload (MLS AEAD carries its own nonce). */
export const MLS_PAYLOAD_NONCE = 'mls';

export const E2EE_NACL_GROUP_LIMIT = 50;
export const MLS_GROUP_LIMIT = 200;

export type MlsMemberHint = {
  id: string;
  mlsReady?: boolean | null;
  mlsSignaturePublicKey?: string | null;
  mlsCredentialIdentity?: string | null;
};

export function isMlsReady(member: MlsMemberHint): boolean {
  return !!(member.mlsReady || member.mlsSignaturePublicKey || member.mlsCredentialIdentity);
}

/** Every member (including the sender) has published an MLS credential or KeyPackages. */
export function conversationSupportsMls(directoryEnabled: boolean, members: MlsMemberHint[]): boolean {
  if (!directoryEnabled) return false;
  if (members.length < 2) return false;
  return members.every(isMlsReady);
}

export function naclGroupOverLimit(memberCount: number): boolean {
  return memberCount > E2EE_NACL_GROUP_LIMIT;
}

export function mlsGroupOverLimit(memberCount: number): boolean {
  return memberCount > MLS_GROUP_LIMIT;
}

/** Deterministic founder so only one client creates the group (avoids epoch races). */
export function mlsFounderId(memberIds: string[]): string {
  if (!memberIds.length) throw new Error('mlsFounderId requires at least one member');
  return [...memberIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
}

export function encodeMlsApplication(plain: unknown): string {
  return JSON.stringify(plain);
}

export function decodeMlsApplication<T = unknown>(plaintext: string): T | null {
  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export function isMlsProtocol(value: string | null | undefined): boolean {
  return value === MLS_PROTOCOL || value === MLS_PAYLOAD_NONCE;
}
