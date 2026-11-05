export interface Shift { start: string; end: string; days: number[] }
export interface PublicUser {
  id: string; displayName: string | null; username: string | null; role: string | null; department: string | null; avatar: string | null;
  identityKey: string | null; keyUpdatedAt: number | null; timezone: string; localTime: string; onShift: boolean; shift: Shift;
  mlsSignaturePublicKey?: string | null; mlsCredentialIdentity?: string | null; mlsKeyUpdatedAt?: number | null; mlsReady?: boolean;
}
export interface SelfUser extends PublicUser {
  identifierKind: 'phone' | 'email'; followPhoneTz: boolean; touringMode: boolean; quietHours: boolean; workMode: boolean; isAdmin: boolean;
  plan: string; planStatus: string | null; planRenewsAt: number | null; profileComplete: boolean;
}
export interface ServerMessage {
  id: string; seq: number; conversationId: string; senderId: string; clientId: string; kind: string; createdAt: number;
  protocol?: 'nacl' | 'mls'; nonce: string | null; ciphertext: string | null; status?: 'sent' | 'delivered' | 'read'; readBy: number; deliveredTo: number; recipients: number;
  readByUserIds?: string[];
}
export interface Conversation {
  id: string; kind: 'direct' | 'group' | 'workspace'; title: string | null; workspaceId: string | null; readonly: boolean; createdAt: number;
  memberCount: number; myRole: string; lastReadSeq: number; unread: number; members: (PublicUser & { convRole: string })[];
  lastMessage: ServerMessage | null; workspace: { id: string; name: string; initial: string; wrapped: boolean } | null;
  lastAnnouncement: { title: string; createdAt: number } | null;
  e2eeError?: string | null;
  mls?: { groupId: string | null; epoch: number | null };
}
export interface Workspace {
  id: string; name: string; initial: string; venue: string; runLabel: string; seatLimit: number; plan: string; memberCount: number;
  departments: { id: string; name: string; count: number }[]; admins: string[]; myRole: 'owner' | 'admin' | 'member'; wrappedAt: number | null; deleteAfter: number | null; conversationId: string | null;
}
export interface Announcement {
  id: string; workspaceId: string; authorId: string; authorName: string; title: string; body: string; requireAck: boolean; respectQuietHours: boolean;
  departmentIds: string[] | null; createdAt: number; mine: boolean; myAckAt: number | null; total: number; acked: number; seenNotAcked: number;
}
export interface WsMember extends PublicUser { wsRole: string; departmentId: string | null; departmentName: string | null; city: string | null }
export interface CallRecord { id: string; direction: 'outgoing' | 'incoming'; other: PublicUser | null; status: string; startedAt: number; answeredAt: number | null; endedAt: number | null; endReason: string | null; durationSec: number }
export interface Plan { id: 'free' | 'production' | 'company'; name: string; description: string; priceGBP: number; period: string; seats: number; productId: string | null }
