import { Server as IOServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { Built, Emitter } from './app.js';
import { verifyAccess } from './auth.js';
import { HttpError } from './util.js';
import { isValidCallId, isSealedSignal } from '../../shared/call-protocol.js';

export const RING_TIMEOUT_MS = 45_000;
/** An active/ringing call survives a participant's socket dropping for this long (network handover, app reload). */
export const CALL_DISCONNECT_GRACE_MS = 20_000;
/** Hard cap on relayed signalling messages per call (ICE trickle + restarts are well under this). */
export const MAX_SIGNALS_PER_CALL = 600;

/** Socket emitter that can be created before the IO server exists (buildApp needs it up front). */
export class LateEmitter implements Emitter {
  io: IOServer | null = null;
  online = new Map<string, number>();
  toUser(userId: string, event: string, data: unknown) { this.io?.to('user:' + userId).emit(event, data); }
  isOnline(userId: string) { return (this.online.get(userId) || 0) > 0; }
}

interface LiveCall { caller: string; callee: string; answered: boolean; signals: number }
export interface RealtimeOpts { ringTimeoutMs?: number; disconnectGraceMs?: number }

export function attachRealtime(http: HttpServer, built: Built, emitter: LateEmitter, opts: RealtimeOpts = {}) {
  const { ctx, calls } = built;
  const ringMs = opts.ringTimeoutMs ?? RING_TIMEOUT_MS;
  const graceMs = opts.disconnectGraceMs ?? CALL_DISCONNECT_GRACE_MS;
  const io = new IOServer(http, { cors: { origin: true }, pingInterval: 10_000, pingTimeout: 8_000 });
  emitter.io = io;
  const ringTimers = new Map<string, NodeJS.Timeout>();
  /** In-memory view of calls that have not ended (busy detection, signal gating). */
  const live = new Map<string, LiveCall>();
  /** Pending "participant went away" timers keyed by `${callId}:${userId}`. */
  const graceTimers = new Map<string, NodeJS.Timeout>();

  const liveCallOf = (userId: string) => { for (const [id, c] of live) if (c.caller === userId || c.callee === userId) return id; return null; };
  const finish = (callId: string, reason: string) => {
    clearTimeout(ringTimers.get(callId)); ringTimers.delete(callId);
    const lc = live.get(callId); live.delete(callId);
    if (lc) for (const u of [lc.caller, lc.callee]) { clearTimeout(graceTimers.get(`${callId}:${u}`)); graceTimers.delete(`${callId}:${u}`); }
    const c = calls.end(callId, reason);
    if (!c) return;
    for (const u of [c.caller_id, c.callee_id]) emitter.toUser(u, 'call:ended', { callId, reason, status: c.status });
  };

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as any)?.token;
      const c = verifyAccess(ctx.db, ctx.cfg, String(token || ''));
      (socket.data as any).userId = c.sub;
      next();
    } catch (e) { next(new Error(e instanceof HttpError ? e.code : 'UNAUTHORIZED')); }
  });

  io.on('connection', (socket: Socket) => {
    const me: string = (socket.data as any).userId;
    socket.join('user:' + me);
    emitter.online.set(me, (emitter.online.get(me) || 0) + 1);
    // Came back within the grace window → keep the call alive.
    for (const [k, t] of graceTimers) if (k.endsWith(':' + me)) { clearTimeout(t); graceTimers.delete(k); }

    /** Returns the call only if `me` is a participant and it has not ended. */
    const participant = (callId: unknown) => {
      if (!isValidCallId(callId)) return null;
      const lc = live.get(callId);
      if (!lc || (lc.caller !== me && lc.callee !== me)) return null;
      return { id: callId, lc, other: lc.caller === me ? lc.callee : lc.caller };
    };

    socket.on('typing', (d: { conversationId: string; to?: string[] }) => {
      if (!d?.conversationId) return;
      const member = ctx.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?').get(d.conversationId, me);
      if (!member) return;
      const members = ctx.db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=?').all(d.conversationId) as { user_id: string }[];
      for (const row of members) if (row.user_id !== me) emitter.toUser(row.user_id, 'typing', { conversationId: d.conversationId, userId: me });
    });

    socket.on('call:invite', async (d: { callId: string; to: string }, ack?: (r: any) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!d || !isValidCallId(d.callId) || typeof d.to !== 'string' || !d.to || d.to === me) throw new HttpError(400, 'BAD_CALL');
        if (calls.get(d.callId)) throw new HttpError(409, 'BAD_CALL');
        if (liveCallOf(me)) throw new HttpError(409, 'ALREADY_IN_CALL');
        const callee = ctx.db.prepare('SELECT quiet_hours, identity_key FROM users WHERE id=?').get(d.to) as any;
        if (!callee) throw new HttpError(404, 'USER_NOT_FOUND');
        if (!callee.identity_key) throw new HttpError(409, 'NO_KEYS');
        const { calleeOnShift, callerName } = calls.start(d.callId, me, d.to);
        if (!calleeOnShift && callee.quiet_hours) {
          await calls.notify(d.to, 'call', `Missed call from ${callerName}`, 'Held during quiet hours', { callId: d.callId });
          reply({ ok: false, reason: 'held' });
          finish(d.callId, 'held');
          return;
        }
        if (liveCallOf(d.to)) {
          reply({ ok: false, reason: 'busy' });
          finish(d.callId, 'busy');
          return;
        }
        live.set(d.callId, { caller: me, callee: d.to, answered: false, signals: 0 });
        emitter.toUser(d.to, 'call:incoming', { callId: d.callId, from: me, callerName });
        if (!emitter.isOnline(d.to)) await calls.notify(d.to, 'call', 'Incoming Understage call', callerName, { callId: d.callId, from: me }, { respectQuiet: false });
        ringTimers.set(d.callId, setTimeout(() => finish(d.callId, 'no-answer'), ringMs));
        reply({ ok: true, calleeOnline: emitter.isOnline(d.to) });
      } catch (e) { reply({ ok: false, reason: e instanceof HttpError ? e.code : 'ERROR' }); }
    });
    socket.on('call:accept', (d: { callId: string }) => {
      const p = participant(d?.callId); if (!p || p.lc.callee !== me || p.lc.answered) return;
      clearTimeout(ringTimers.get(p.id)); ringTimers.delete(p.id);
      p.lc.answered = true;
      calls.answer(p.id);
      emitter.toUser(p.other, 'call:accepted', { callId: p.id });
      socket.to('user:' + me).emit('call:answered-elsewhere', { callId: p.id });
    });
    socket.on('call:decline', (d: { callId: string; reason?: string }) => {
      const p = participant(d?.callId); if (!p) return;
      if (p.lc.callee !== me) return finish(p.id, 'hangup'); // caller "declining" is a cancel
      if (p.lc.answered) return; // can't decline an answered call; use call:end
      finish(p.id, d?.reason === 'busy' ? 'busy' : 'declined');
    });
    socket.on('call:end', (d: { callId: string; reason?: string }) => {
      const p = participant(d?.callId); if (p) finish(p.id, d?.reason === 'failed' ? 'failed' : 'hangup');
    });
    socket.on('call:signal', (d: { callId: string; data: unknown }) => {
      const p = participant(d?.callId);
      // Signalling only flows once the callee has accepted, only between the two parties, and only as sealed boxes.
      if (!p || !p.lc.answered || !isSealedSignal(d?.data)) return;
      if (++p.lc.signals > MAX_SIGNALS_PER_CALL) return;
      emitter.toUser(p.other, 'call:signal', { callId: p.id, from: me, data: { n: (d.data as any).n, c: (d.data as any).c } });
    });

    socket.on('disconnect', () => {
      const left = Math.max(0, (emitter.online.get(me) || 1) - 1);
      emitter.online.set(me, left);
      if (left > 0) return;
      for (const [id, c] of live) {
        if (c.caller !== me && c.callee !== me) continue;
        const k = `${id}:${me}`;
        clearTimeout(graceTimers.get(k));
        graceTimers.set(k, setTimeout(() => { graceTimers.delete(k); if (live.has(id)) finish(id, 'disconnected'); }, graceMs));
      }
    });
  });
  io.on('close', () => { for (const t of [...ringTimers.values(), ...graceTimers.values()]) clearTimeout(t); });
  return io;
}
