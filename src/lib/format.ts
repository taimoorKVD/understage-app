import type { Conversation, PublicUser } from './types';
import type { PlainMessage } from '../../shared/e2ee';
import type { LocalMessage } from './db';

export const otherMember = (c: Conversation, me: string): PublicUser | undefined => c.members.find(m => m.id !== me);
export function convTitle(c: Conversation, me: string) {
  if (c.kind === 'direct') return otherMember(c, me)?.displayName || 'Unknown';
  if (c.kind === 'workspace') return c.workspace?.name || c.title || 'Workspace';
  return c.title || c.members.filter(m => m.id !== me).map(m => (m.displayName || '').split(' ')[0]).join(', ') || 'Group';
}
export function preview(b: PlainMessage | null | undefined) {
  if (!b) return '🔒 Encrypted message';
  switch (b.type) {
    case 'text': return b.text;
    case 'voice': return `🎤 Voice note · ${Math.floor(b.durationSec / 60)}:${String(Math.round(b.durationSec % 60)).padStart(2, '0')}`;
    case 'image': return b.caption ? `📷 ${b.caption}` : '📷 Photo';
    case 'doc': return `📄 ${b.attachment.name}`;
    case 'contact': return `👤 ${b.displayName}`;
    case 'system': return b.text;
  }
}
export function lastPreview(c: Conversation, msgs: LocalMessage[] | undefined, me: string) {
  if (c.kind === 'workspace' && c.lastAnnouncement && (!c.lastMessage || c.lastAnnouncement.createdAt >= c.lastMessage.createdAt)) return { text: `Announcement: ${c.lastAnnouncement.title}`, at: c.lastAnnouncement.createdAt };
  const local = msgs?.length ? msgs[msgs.length - 1] : null;
  const lm = c.lastMessage;
  if (local && (!lm || local.createdAt >= lm.createdAt)) {
    const who = c.kind !== 'direct' && local.senderId !== me ? `${(c.members.find(m => m.id === local.senderId)?.displayName || '').split(' ')[0]}: ` : local.senderId === me ? 'You: ' : '';
    return { text: who + preview(local.body), at: local.createdAt, status: local.senderId === me ? local.status : undefined };
  }
  if (lm) return { text: preview(null), at: lm.createdAt };
  return { text: c.kind === 'direct' ? 'Say hello 👋' : 'No messages yet', at: c.createdAt };
}
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
