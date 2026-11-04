/**
 * Offline outbox — pure, storage-agnostic logic (persisted by the app in SQLite).
 * A message is only "sent" after the server acknowledges it; there is no optimistic success.
 */
export type OutboxState = 'pending' | 'sending' | 'failed' | 'sent';

export interface OutboxItem<P = unknown> {
  clientId: string;
  conversationId: string;
  payload: P;              // whatever the sender needs to (re)build the request
  state: OutboxState;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  error?: string;
  serverId?: string;
}

export class PermanentSendError extends Error {}

export interface SendResult { serverId: string }
export type Sender<P> = (item: OutboxItem<P>) => Promise<SendResult>;

export const MAX_ATTEMPTS = 6;
export const backoffMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

export class Outbox<P = unknown> {
  items: OutboxItem<P>[] = [];
  private flushing = false;
  constructor(private persist: (items: OutboxItem<P>[]) => void = () => {}, private clock: () => number = Date.now) {}

  load(items: OutboxItem<P>[]) {
    // anything left "sending" from a crash goes back to pending — the server dedupes by clientId
    this.items = items.map(i => (i.state === 'sending' ? { ...i, state: 'pending' } : i));
  }

  enqueue(clientId: string, conversationId: string, payload: P): OutboxItem<P> {
    const item: OutboxItem<P> = { clientId, conversationId, payload, state: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: this.clock() };
    this.items.push(item); this.persist(this.items);
    return item;
  }

  retry(clientId: string) {
    const i = this.items.find(x => x.clientId === clientId);
    if (i && i.state === 'failed') { i.state = 'pending'; i.attempts = 0; i.nextAttemptAt = 0; i.error = undefined; this.persist(this.items); }
  }

  remove(clientId: string) { this.items = this.items.filter(i => i.clientId !== clientId); this.persist(this.items); }

  pending() { return this.items.filter(i => i.state !== 'sent'); }

  /** Send due items in FIFO order per conversation. Stops a conversation on its first transient failure to preserve order. */
  async flush(send: Sender<P>, online: boolean, onChange?: (i: OutboxItem<P>) => void) {
    if (!online || this.flushing) return 0;
    this.flushing = true;
    let sent = 0;
    const blocked = new Set<string>();
    try {
      for (const item of [...this.items]) {
        if (item.state !== 'pending' || blocked.has(item.conversationId) || item.nextAttemptAt > this.clock()) {
          if (item.state === 'pending') blocked.add(item.conversationId);
          continue;
        }
        item.state = 'sending'; item.attempts++; onChange?.(item);
        try {
          const r = await send(item);
          item.state = 'sent'; item.serverId = r.serverId; item.error = undefined; sent++;
        } catch (e) {
          const permanent = e instanceof PermanentSendError;
          item.error = (e as Error).message;
          if (permanent || item.attempts >= MAX_ATTEMPTS) item.state = 'failed';
          else { item.state = 'pending'; item.nextAttemptAt = this.clock() + backoffMs(item.attempts); }
          blocked.add(item.conversationId);
        }
        onChange?.(item);
        this.persist(this.items);
      }
      this.items = this.items.filter(i => i.state !== 'sent');
      this.persist(this.items);
    } finally { this.flushing = false; }
    return sent;
  }
}
