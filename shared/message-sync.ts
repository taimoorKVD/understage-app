/** Pure helpers for local message merge + reconnect catch-up. No RN/server deps. */

export type SyncableMessage = {
  key: string;
  id?: string | null;
  clientId: string;
  seq?: number | null;
  createdAt: number;
};

/** Drop prior copies of the same message (by key, clientId, or server id) then insert in seq/time order. */
export function mergeMessageList<T extends SyncableMessage>(list: T[], incoming: T): T[] {
  const next = list.filter(x =>
    x.key !== incoming.key &&
    x.clientId !== incoming.clientId &&
    !(incoming.id && x.id && x.id === incoming.id),
  );
  next.push(incoming);
  next.sort((a, b) => (a.seq ?? 9e15) - (b.seq ?? 9e15) || a.createdAt - b.createdAt);
  return next;
}

/** Advance the /sync cursor to the highest seq seen. */
export function nextSyncCursor(current: number, messages: { seq?: number | null }[]): number {
  let cursor = current;
  for (const m of messages) {
    if (typeof m.seq === 'number' && m.seq > cursor) cursor = m.seq;
  }
  return cursor;
}

/** Messages a reconnecting client should ingest from GET /sync?since=cursor. */
export function catchUpMessages<T extends { seq?: number | null }>(messages: T[], since: number): T[] {
  return messages.filter(m => typeof m.seq === 'number' && m.seq > since);
}
