/**
 * 1:1 audio call state machine + peer-connection lifecycle, free of React Native imports so it can be unit-tested
 * with fake peers/transports (server/test/call-engine.test.ts). src/lib/calls.ts adapts it to Socket.IO, nacl.box
 * sealing, react-native-webrtc and expo-audio.
 *
 * Roles: the caller is the only side that creates offers (initial + ICE restart), so there is no offer glare.
 * The callee asks for a restart with a `restart` signal when its own connection drops.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';
export type EndReason =
  | 'hangup' | 'declined' | 'busy' | 'no-answer' | 'held' | 'failed' | 'disconnected' | 'answered-elsewhere'
  | 'mic-denied' | 'offline' | 'blocked';

export interface CallSnapshot {
  phase: CallPhase; callId: string | null; peerId: string | null; peerName: string; direction: 'out' | 'in';
  answeredAt: number | null; muted: boolean; speaker: boolean; status: string; endReason: EndReason | null;
  /** Set while callee finishes native permission/mic setup, before SDP can be processed. */
  accepting: boolean;
}
export const IDLE_CALL: CallSnapshot = {
  phase: 'idle', callId: null, peerId: null, peerName: '', direction: 'out', answeredAt: null, muted: false, speaker: false, status: '', endReason: null, accepting: false,
};

export const CALL_TIMEOUTS = {
  /** Client-side ring fallback; the server ends unanswered calls at 45 s. */
  ringMs: 50_000,
  /** Accept → first `connected` must happen within this window. */
  connectMs: 25_000,
  /** How long a `disconnected` ICE state may last before we force an ICE restart. */
  disconnectGraceMs: 3_000,
  /** Total time we stay in `reconnecting` before giving up. */
  reconnectMs: 20_000,
  /** Ended screen dwell before returning to idle. */
  endedDwellMs: 1_800,
  maxIceRestarts: 3,
};
export type CallTimeouts = typeof CALL_TIMEOUTS;

export type SignalMsg =
  | { t: 'sdp'; d: { type: 'offer' | 'answer'; sdp: string } }
  | { t: 'ice'; c: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }
  | { t: 'restart' };

/** Validates a decrypted signalling message. Anything else is dropped. */
export function parseSignal(m: unknown): SignalMsg | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as any;
  if (o.t === 'sdp' && o.d && (o.d.type === 'offer' || o.d.type === 'answer') && typeof o.d.sdp === 'string' && o.d.sdp.length < 60_000) {
    return { t: 'sdp', d: { type: o.d.type, sdp: o.d.sdp } };
  }
  if (o.t === 'ice' && o.c && typeof o.c.candidate === 'string' && o.c.candidate.length < 2_000) {
    return { t: 'ice', c: { candidate: o.c.candidate, sdpMid: o.c.sdpMid ?? null, sdpMLineIndex: typeof o.c.sdpMLineIndex === 'number' ? o.c.sdpMLineIndex : null } };
  }
  if (o.t === 'restart') return { t: 'restart' };
  return null;
}

export function endStatusText(reason: EndReason | string, peerName: string): string {
  switch (reason) {
    case 'declined': return 'Declined';
    case 'busy': return `${peerName || 'They'} ${peerName ? 'is' : 'are'} on another call`;
    case 'no-answer': return 'No answer';
    case 'held': return `${peerName} is off shift · call held`;
    case 'failed': return 'Call failed';
    case 'disconnected': return 'Connection lost';
    case 'mic-denied': return 'Microphone access is off';
    case 'offline': return 'You are offline';
    case 'blocked': return 'Call unavailable';
    default: return 'Call ended';
  }
}

// ---- minimal WebRTC surface the engine needs (react-native-webrtc satisfies it)
export interface TrackLike { kind?: string; enabled: boolean; stop(): void }
export interface StreamLike { getTracks(): TrackLike[]; getAudioTracks(): TrackLike[]; release?(): void }
export interface PeerLike {
  connectionState?: string; iceConnectionState?: string; remoteDescription: unknown; signalingState?: string;
  addEventListener(ev: string, fn: (e: any) => void): void;
  removeEventListener?(ev: string, fn: (e: any) => void): void;
  createOffer(opts?: any): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(d: any): Promise<void>;
  setRemoteDescription(d: any): Promise<void>;
  addIceCandidate(c: any): Promise<void>;
  close(): void;
}

export interface InviteResult { ok: boolean; reason?: string; calleeOnline?: boolean }
export interface CallDeps {
  invite(callId: string, to: string): Promise<InviteResult>;
  accept(callId: string): void;
  decline(callId: string, reason?: 'busy'): void;
  end(callId: string, reason: 'hangup' | 'failed'): void;
  signal(callId: string, msg: SignalMsg): void;
  /** Builds a peer connection (with ICE servers) and captures the microphone. Throw `{ name: 'NotAllowedError' }` on denial. */
  createMedia(): Promise<{ pc: PeerLike; stream: StreamLike }>;
  /** Configure the OS audio session for a call (active) or release it. */
  setAudio(o: { active: boolean; speaker: boolean }): Promise<void> | void;
  newId(): string;
  onChange(s: CallSnapshot): void;
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
  now?(): number;
  log?(msg: string): void;
}

type TimerKey = 'ring' | 'connect' | 'grace' | 'reconnect' | 'dwell';

export class CallEngine {
  s: CallSnapshot = { ...IDLE_CALL };
  private pc: PeerLike | null = null;
  private stream: StreamLike | null = null;
  private listeners: [string, (e: any) => void][] = [];
  private pendingIce: SignalMsg[] = [];
  private queued: SignalMsg[] = [];
  private chain: Promise<void> = Promise.resolve();
  private acceptingPromise: Promise<void> | null = null;
  private timers = new Map<TimerKey, unknown>();
  private restarts = 0;
  private gen = 0;
  private t: CallTimeouts;

  constructor(private d: CallDeps, timeouts: Partial<CallTimeouts> = {}) { this.t = { ...CALL_TIMEOUTS, ...timeouts }; }

  private get tm() { return this.d.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as any) }; }
  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private set(p: Partial<CallSnapshot>) { this.s = { ...this.s, ...p }; this.d.onChange(this.s); }
  private arm(k: TimerKey, ms: number, fn: () => void) { this.disarm(k); this.timers.set(k, this.tm.set(() => { this.timers.delete(k); fn(); }, ms)); }
  private disarm(k: TimerKey) { const h = this.timers.get(k); if (h !== undefined) { this.tm.clear(h); this.timers.delete(k); } }
  private live() { return this.s.phase !== 'idle' && this.s.phase !== 'ended'; }
  get hasMedia() { return !!this.pc; }

  // ---------- user actions
  async start(peerId: string, peerName: string, callId: string = this.d.newId()): Promise<void> {
    if (this.live()) return;
    this.resetForNew();
    this.set({ ...IDLE_CALL, phase: 'outgoing', callId, peerId, peerName, direction: 'out', status: 'Calling…' });
    this.arm('ring', this.t.ringMs, () => this.hangup('no-answer'));
    let r: InviteResult;
    try { r = await this.d.invite(callId, peerId); } catch { r = { ok: false, reason: 'offline' }; }
    if (this.s.callId !== callId || this.s.phase !== 'outgoing') return;
    if (r.ok) this.set({ status: r.calleeOnline ? 'Ringing…' : 'Calling…' });
    else this.finish(r.reason === 'held' ? 'held' : r.reason === 'busy' ? 'busy' : r.reason === 'offline' ? 'offline' : r.reason === 'BLOCKED' ? 'blocked' : 'failed');
  }

  async accept(): Promise<void> {
    if (this.acceptingPromise) return this.acceptingPromise;
    if (this.s.phase !== 'incoming' || !this.s.callId) return;
    const callId = this.s.callId;
    const operation = this.acceptIncoming(callId);
    this.acceptingPromise = operation;
    try { await operation; }
    finally { if (this.acceptingPromise === operation) this.acceptingPromise = null; }
  }

  private async acceptIncoming(callId: string): Promise<void> {
    this.disarm('ring');
    this.set({ phase: 'connecting', status: 'Connecting…', accepting: true });
    this.arm('connect', this.t.connectMs, () => this.hangup('failed'));
    this.d.accept(callId);
    try { await this.ensureMedia(callId); }
    finally { if (this.s.callId === callId) this.set({ accepting: false }); }
  }

  decline(): void {
    if (this.s.phase !== 'incoming' || !this.s.callId) return;
    this.d.decline(this.s.callId);
    this.finish('declined');
  }

  /** Local hang-up / give-up. Tells the server, then tears down. */
  hangup(reason: EndReason = 'hangup'): void {
    if (!this.live() || !this.s.callId) return;
    if (this.s.phase === 'incoming' && reason === 'hangup') return this.decline();
    this.d.end(this.s.callId, reason === 'hangup' || reason === 'no-answer' ? 'hangup' : 'failed');
    this.finish(reason);
  }

  toggleMute(): void {
    const muted = !this.s.muted;
    this.applyMute(muted);
    this.set({ muted });
  }

  async toggleSpeaker(): Promise<void> {
    const speaker = !this.s.speaker;
    this.set({ speaker });
    if (this.pc) await Promise.resolve(this.d.setAudio({ active: true, speaker })).catch(() => {});
  }

  // ---------- server / network events
  onIncoming(d: { callId: string; from: string; callerName: string }): 'ringing' | 'busy' {
    if (this.live() && this.s.callId !== d.callId) { this.d.decline(d.callId, 'busy'); return 'busy'; }
    if (this.live()) return 'ringing';
    this.resetForNew();
    this.set({ ...IDLE_CALL, phase: 'incoming', callId: d.callId, peerId: d.from, peerName: d.callerName, direction: 'in', status: 'Understage audio call…' });
    this.arm('ring', this.t.ringMs, () => { if (this.s.phase === 'incoming') this.finish('no-answer'); });
    return 'ringing';
  }

  async onAccepted(d: { callId: string }): Promise<void> {
    if (d.callId !== this.s.callId || this.s.phase !== 'outgoing') return;
    const callId = d.callId;
    this.disarm('ring');
    this.set({ phase: 'connecting', status: 'Connecting…' });
    this.arm('connect', this.t.connectMs, () => this.hangup('failed'));
    if (!(await this.ensureMedia(callId))) return;
    await this.offer(callId, false);
  }

  onSignal(callId: string, raw: unknown): Promise<void> {
    if (callId !== this.s.callId || !this.live()) return Promise.resolve();
    const msg = parseSignal(raw);
    if (!msg) { this.d.log?.('dropped malformed call signal'); return Promise.resolve(); }
    if (!this.pc) { this.queued.push(msg); return Promise.resolve(); }
    return this.enqueue(() => this.handle(callId, msg));
  }

  onEnded(d: { callId: string; reason: string }): void {
    if (d.callId !== this.s.callId) return;
    this.finish((d.reason as EndReason) || 'hangup');
  }

  onAnsweredElsewhere(d: { callId: string }): void {
    if (d.callId !== this.s.callId) return;
    this.teardown();
    this.set({ ...IDLE_CALL });
  }

  /** The signalling socket came back (e.g. Wi-Fi ↔ cellular). Kick an ICE restart if media is up. */
  onSocketReconnected(): void {
    if (!this.pc || !this.s.callId) return;
    if (this.s.phase !== 'active' && this.s.phase !== 'reconnecting') return;
    const st = this.pc.connectionState ?? this.pc.iceConnectionState;
    if (st === 'connected' || st === 'completed') return;
    this.requestRestart();
  }

  // ---------- internals
  private enqueue(fn: () => Promise<void>) {
    const p = this.chain.then(fn).catch(e => { this.d.log?.(`signal error: ${String((e as any)?.message ?? e)}`); });
    this.chain = p;
    return p;
  }

  private async ensureMedia(callId: string): Promise<boolean> {
    if (this.pc) return true;
    const gen = this.gen;
    let m: { pc: PeerLike; stream: StreamLike };
    try { m = await this.d.createMedia(); } catch (e: any) {
      if (gen === this.gen && this.s.callId === callId) this.hangup(e?.name === 'NotAllowedError' ? 'mic-denied' : 'failed');
      return false;
    }
    if (gen !== this.gen || this.s.callId !== callId || !this.live()) { // call ended while we were opening the mic
      try { m.stream.getTracks().forEach(t => t.stop()); m.stream.release?.(); m.pc.close(); } catch {}
      return false;
    }
    this.pc = m.pc; this.stream = m.stream;
    this.gen++;
    const mediaGen = this.gen;
    this.applyMute(this.s.muted);
    this.on('icecandidate', (e: any) => { const c = e?.candidate; if (c && c.candidate) this.d.signal(callId, { t: 'ice', c: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } }); });
    this.on('connectionstatechange', () => this.onConn(this.pc?.connectionState));
    this.on('iceconnectionstatechange', () => { const s = this.pc?.iceConnectionState; if (s === 'completed') this.onConn('connected'); else if (s === 'disconnected' || s === 'failed' || s === 'connected') this.onConn(s); });
    await Promise.resolve(this.d.setAudio({ active: true, speaker: this.s.speaker })).catch(() => {});
    if (mediaGen !== this.gen || this.s.callId !== callId || !this.live()) return false;
    // Drain sequentially on the same promise chain as live signals so ICE cannot overtake an SDP offer.
    for (const q of this.queued.splice(0)) await this.enqueue(() => this.handle(callId, q));
    return mediaGen === this.gen && this.s.callId === callId && this.live();
  }

  private on(ev: string, fn: (e: any) => void) {
    const gen = this.gen;
    const wrapped = (e: any) => { if (gen === this.gen) fn(e); };
    this.pc!.addEventListener(ev, wrapped);
    this.listeners.push([ev, wrapped]);
  }

  private onConn(state: string | undefined) {
    if (!this.live()) return;
    if (state === 'connected') {
      this.disarm('connect'); this.disarm('grace'); this.disarm('reconnect');
      this.restarts = 0;
      this.set({ phase: 'active', status: '', answeredAt: this.s.answeredAt ?? this.now() });
    } else if (state === 'disconnected') {
      if (this.s.phase === 'active') this.set({ phase: 'reconnecting', status: 'Reconnecting…' });
      if (this.s.phase === 'reconnecting') this.armReconnectDeadline();
      this.arm('grace', this.t.disconnectGraceMs, () => this.requestRestart());
    } else if (state === 'failed') {
      if (this.s.phase === 'active') this.set({ phase: 'reconnecting', status: 'Reconnecting…' });
      if (this.s.phase === 'reconnecting') this.armReconnectDeadline();
      this.disarm('grace');
      this.requestRestart();
    }
  }

  private armReconnectDeadline() {
    if (!this.timers.has('reconnect')) this.arm('reconnect', this.t.reconnectMs, () => this.hangup('disconnected'));
  }

  private requestRestart() {
    if (!this.pc || !this.s.callId || !this.live()) return;
    if (this.restarts >= this.t.maxIceRestarts) { this.hangup(this.s.answeredAt ? 'disconnected' : 'failed'); return; }
    this.restarts++;
    const callId = this.s.callId;
    if (this.s.direction === 'out') void this.enqueue(() => this.offer(callId, true));
    else this.d.signal(callId, { t: 'restart' });
  }

  private async offer(callId: string, iceRestart: boolean) {
    const pc = this.pc; if (!pc || this.s.callId !== callId) return;
    try {
      const o = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
      if (this.pc !== pc) return;
      await pc.setLocalDescription(o);
      if (this.pc !== pc || this.s.callId !== callId || !this.live()) return;
      this.d.signal(callId, { t: 'sdp', d: { type: 'offer', sdp: o.sdp } });
    } catch (e) {
      this.d.log?.(`offer failed: ${String((e as any)?.message ?? e)}`);
      if (!iceRestart) this.hangup('failed');
    }
  }

  private async handle(callId: string, msg: SignalMsg) {
    const pc = this.pc;
    if (!pc || this.s.callId !== callId || !this.live()) return;
    if (msg.t === 'sdp') {
      if (msg.d.type === 'offer' && this.s.direction === 'out') return; // caller never accepts offers (no glare)
      if (msg.d.type === 'answer' && this.s.direction === 'in') return;
      await pc.setRemoteDescription(msg.d);
      if (this.pc !== pc || this.s.callId !== callId || !this.live()) return;
      if (msg.d.type === 'offer') {
        const a = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(a);
        if (this.pc !== pc || this.s.callId !== callId || !this.live()) return;
        this.d.signal(callId, { t: 'sdp', d: { type: 'answer', sdp: a.sdp } });
      }
      for (const c of this.pendingIce.splice(0)) if (c.t === 'ice') await pc.addIceCandidate(c.c).catch(() => {});
    } else if (msg.t === 'ice') {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.c).catch(() => {});
      else this.pendingIce.push(msg);
    } else if (msg.t === 'restart' && this.s.direction === 'out') {
      if (this.s.phase === 'active') this.set({ phase: 'reconnecting', status: 'Reconnecting…' });
      if (this.s.phase === 'reconnecting') this.armReconnectDeadline();
      if (this.restarts >= this.t.maxIceRestarts) { this.hangup('disconnected'); return; }
      this.restarts++;
      await this.offer(callId, true);
    }
  }

  private applyMute(muted: boolean) { this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted; }); }

  private resetForNew() { this.teardown(); this.disarm('dwell'); }

  /** Stops tracks, closes the peer connection, clears timers/queues. Idempotent. */
  private teardown() {
    this.gen++;
    for (const k of ['ring', 'connect', 'grace', 'reconnect'] as TimerKey[]) this.disarm(k);
    const pc = this.pc, stream = this.stream, hadMedia = !!pc;
    this.pc = null; this.stream = null;
    for (const [ev, fn] of this.listeners.splice(0)) { try { pc?.removeEventListener?.(ev, fn); } catch {} }
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { stream?.release?.(); } catch {}
    try { pc?.close(); } catch {}
    this.pendingIce.length = 0; this.queued.length = 0; this.restarts = 0;
    this.chain = Promise.resolve();
    if (hadMedia) void Promise.resolve(this.d.setAudio({ active: false, speaker: false })).catch(() => {});
  }

  private finish(reason: EndReason) {
    if (!this.live()) return;
    this.teardown();
    this.set({ phase: 'ended', status: endStatusText(reason, this.s.peerName), endReason: reason });
    this.arm('dwell', this.t.endedDwellMs, () => { if (this.s.phase === 'ended') this.set({ ...IDLE_CALL }); });
  }
}
