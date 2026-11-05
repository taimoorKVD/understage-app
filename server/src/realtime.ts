import { Server as IOServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { Built, Emitter } from './app.js';
import { verifyAccess } from './auth.js';
import { HttpError } from './util.js';

export const RING_TIMEOUT_MS = 45_000;

/** Socket emitter that can be created before the IO server exists (buildApp needs it up front). */
export class LateEmitter implements Emitter {
  io: IOServer | null = null;
  online = new Map<string, number>();
  toUser(userId: string, event: string, data: unknown) { this.io?.to('user:' + userId).emit(event, data); }
  isOnline(userId: string) { return (this.online.get(userId) || 0) > 0; }
}

export function attachRealtime(http: HttpServer, built: Built, emitter: LateEmitter) {
  const { ctx, calls } = built;
  const io = new IOServer(http, { cors: { origin: true }, pingInterval: 10_000, pingTimeout: 8_000 });
  emitter.io = io;
  const ringTimers = new Map<string, NodeJS.Timeout>();

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

    const participant = (callId: string) => {
      const c = calls.get(callId);
      if (!c || (c.caller_id !== me && c.callee_id !== me)) return null;
      return { c, other: c.caller_id === me ? c.callee_id : c.caller_id };
    };
    const finish = (callId: string, reason: string) => {
      clearTimeout(ringTimers.get(callId)); ringTimers.delete(callId);
      const c = calls.end(callId, reason);
      if (!c) return;
      for (const u of [c.caller_id, c.callee_id]) emitter.toUser(u, 'call:ended', { callId, reason, status: c.status });
    };

    socket.on('typing', (d: { conversationId: string; to?: string[] }) => {
      if (!d?.conversationId) return;
      const member = ctx.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?').get(d.conversationId, me);
      if (!member) return;
      const members = ctx.db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=?').all(d.conversationId) as { user_id: string }[];
      for (const row of members) if (row.user_id !== me) emitter.toUser(row.user_id, 'typing', { conversationId: d.conversationId, userId: me });
    });

    socket.on('call:invite', async (d: { callId: string; to: string }, ack?: (r: any) => void) => {
      try {
        if (!d?.callId || !d?.to || d.to === me) throw new HttpError(400, 'BAD_CALL');
        const { calleeOnShift, callerName } = calls.start(d.callId, me, d.to);
        const callee = ctx.db.prepare('SELECT quiet_hours FROM users WHERE id=?').get(d.to) as any;
        if (!calleeOnShift && callee?.quiet_hours) {
          await calls.notify(d.to, 'call', `Missed call from ${callerName}`, 'Held during quiet hours', { callId: d.callId });
          ack?.({ ok: false, reason: 'held' });
          finish(d.callId, 'held');
          return;
        }
        emitter.toUser(d.to, 'call:incoming', { callId: d.callId, from: me, callerName });
        if (!emitter.isOnline(d.to)) await calls.notify(d.to, 'call', 'Incoming Understage call', callerName, { callId: d.callId, from: me }, { respectQuiet: false });
        ringTimers.set(d.callId, setTimeout(() => finish(d.callId, 'no-answer'), RING_TIMEOUT_MS));
        ack?.({ ok: true, calleeOnline: emitter.isOnline(d.to) });
      } catch (e) { ack?.({ ok: false, reason: e instanceof HttpError ? e.code : 'ERROR' }); }
    });
    socket.on('call:accept', (d: { callId: string }) => {
      const p = participant(d?.callId); if (!p || p.c.callee_id !== me) return;
      clearTimeout(ringTimers.get(d.callId)); ringTimers.delete(d.callId);
      calls.answer(d.callId);
      emitter.toUser(p.other, 'call:accepted', { callId: d.callId });
      socket.to('user:' + me).emit('call:answered-elsewhere', { callId: d.callId });
    });
    socket.on('call:decline', (d: { callId: string }) => { const p = participant(d?.callId); if (p) finish(d.callId, 'declined'); });
    socket.on('call:end', (d: { callId: string; reason?: string }) => { const p = participant(d?.callId); if (p) finish(d.callId, d.reason === 'failed' ? 'failed' : 'hangup'); });
    socket.on('call:signal', (d: { callId: string; data: unknown }) => {
      const p = participant(d?.callId); if (!p) return;
      emitter.toUser(p.other, 'call:signal', { callId: d.callId, from: me, data: d.data });
    });

    socket.on('disconnect', () => {
      emitter.online.set(me, Math.max(0, (emitter.online.get(me) || 1) - 1));
    });
  });
  return io;
}
