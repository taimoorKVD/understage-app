import { describe, it, expect, beforeEach } from 'vitest';
import { CallEngine, parseSignal, endStatusText, type CallDeps, type CallSnapshot, type SignalMsg } from '../../shared/call-engine';

/** Fake RTCPeerConnection: records calls and lets the test drive connection-state events. */
class FakePeer {
  connectionState = 'new'; iceConnectionState = 'new'; remoteDescription: any = null; closed = false;
  offers: any[] = []; answers = 0; ice: any[] = []; local: any[] = [];
  private l = new Map<string, Set<(e: any) => void>>();
  addEventListener(ev: string, fn: (e: any) => void) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev)!.add(fn); }
  removeEventListener(ev: string, fn: (e: any) => void) { this.l.get(ev)?.delete(fn); }
  listenerCount() { let n = 0; this.l.forEach(s => (n += s.size)); return n; }
  fire(ev: string, e: any = {}) { this.l.get(ev)?.forEach(f => f(e)); }
  setConn(s: string) { this.connectionState = s; this.fire('connectionstatechange'); }
  async createOffer(o?: any) { this.offers.push(o ?? {}); return { type: 'offer', sdp: `offer-${this.offers.length}` }; }
  async createAnswer() { this.answers++; return { type: 'answer', sdp: `answer-${this.answers}` }; }
  async setLocalDescription(d: any) { this.local.push(d); }
  async setRemoteDescription(d: any) { this.remoteDescription = d; }
  async addIceCandidate(c: any) { this.ice.push(c); }
  close() { this.closed = true; }
}
class FakeTrack { enabled = true; stopped = false; stop() { this.stopped = true; } }

/** Manual clock so timeouts are deterministic. */
class Clock {
  t = 0; private q: { at: number; fn: () => void; id: number }[] = []; private n = 0;
  set = (fn: () => void, ms: number) => { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; };
  clear = (h: unknown) => { this.q = this.q.filter(x => x.id !== h); };
  advance(ms: number) { const end = this.t + ms; for (;;) { this.q.sort((a, b) => a.at - b.at); const x = this.q[0]; if (!x || x.at > end) break; this.q.shift(); this.t = x.at; x.fn(); } this.t = end; }
}
const flush = () => new Promise(r => setTimeout(r, 0));

function harness(opts: { micDenied?: boolean; inviteResult?: any; audioDelay?: boolean } = {}) {
  const clock = new Clock();
  const sent: { ev: string; callId: string; arg?: any }[] = [];
  const signals: SignalMsg[] = [];
  const audio: { active: boolean; speaker: boolean }[] = [];
  const states: CallSnapshot[] = [];
  let peer: FakePeer | null = null; let track: FakeTrack | null = null; let released = false;
  let releaseAudio: (() => void) | null = null;
  const deps: CallDeps = {
    invite: async (callId, to) => { sent.push({ ev: 'invite', callId, arg: to }); return opts.inviteResult ?? { ok: true, calleeOnline: true }; },
    accept: callId => { sent.push({ ev: 'accept', callId }); },
    decline: (callId, reason) => { sent.push({ ev: 'decline', callId, arg: reason }); },
    end: (callId, reason) => { sent.push({ ev: 'end', callId, arg: reason }); },
    signal: (_id, m) => { signals.push(m); },
    createMedia: async () => {
      if (opts.micDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      peer = new FakePeer(); track = new FakeTrack();
      const t = track;
      return { pc: peer, stream: { getTracks: () => [t], getAudioTracks: () => [t], release: () => { released = true; } } };
    },
    setAudio: o => { audio.push(o); return opts.audioDelay && o.active ? new Promise<void>(resolve => { releaseAudio = resolve; }) : undefined; },
    newId: () => 'call-0001',
    onChange: s => { states.push(s); },
    timers: { set: clock.set, clear: clock.clear },
    now: () => clock.t,
  };
  const e = new CallEngine(deps);
  return { e, clock, sent, signals, audio, states, releaseAudio: () => releaseAudio?.(), get peer() { return peer!; }, get track() { return track!; }, get released() { return released; } };
}

describe('call engine — state machine', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('outgoing: ringing → connecting → active, sends a sealed-able offer, records answeredAt once', async () => {
    await h.e.start('u_b', 'Bea');
    expect(h.e.s).toMatchObject({ phase: 'outgoing', status: 'Ringing…', callId: 'call-0001' });
    await h.e.onAccepted({ callId: 'call-0001' }); await flush();
    expect(h.e.s.phase).toBe('connecting');
    expect(h.signals[0]).toEqual({ t: 'sdp', d: { type: 'offer', sdp: 'offer-1' } });
    expect(h.audio.at(-1)).toEqual({ active: true, speaker: false });
    await h.e.onSignal('call-0001', { t: 'sdp', d: { type: 'answer', sdp: 'answer-x' } });
    h.clock.advance(1000); h.peer.setConn('connected');
    expect(h.e.s).toMatchObject({ phase: 'active', answeredAt: 1000 });
  });

  it('outgoing ring timeout ends with "No answer" and tells the server', async () => {
    await h.e.start('u_b', 'Bea');
    h.clock.advance(50_000);
    expect(h.e.s).toMatchObject({ phase: 'ended', status: 'No answer' });
    expect(h.sent.find(s => s.ev === 'end')).toMatchObject({ arg: 'hangup' });
    h.clock.advance(2000);
    expect(h.e.s.phase).toBe('idle');
  });

  it('connect timeout fails the call and tears down media', async () => {
    await h.e.start('u_b', 'Bea'); await h.e.onAccepted({ callId: 'call-0001' }); await flush();
    h.clock.advance(25_000);
    expect(h.e.s).toMatchObject({ phase: 'ended', status: 'Call failed' });
    expect(h.peer.closed).toBe(true); expect(h.track.stopped).toBe(true); expect(h.released).toBe(true);
    expect(h.peer.listenerCount()).toBe(0);
    expect(h.audio.at(-1)).toEqual({ active: false, speaker: false });
  });

  it('server-reported busy / declined / held map to clear end states', async () => {
    const busy = harness({ inviteResult: { ok: false, reason: 'busy' } });
    await busy.e.start('u_b', 'Bea');
    expect(busy.e.s).toMatchObject({ phase: 'ended', endReason: 'busy', status: 'Bea is on another call' });
    await h.e.start('u_b', 'Bea'); h.e.onEnded({ callId: 'call-0001', reason: 'declined' });
    expect(h.e.s.status).toBe('Declined');
    expect(endStatusText('held', 'Bea')).toBe('Bea is off shift · call held');
  });

  it('incoming: accept builds media, answers the offer, flushes ICE queued before the remote description', async () => {
    h.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    expect(h.e.s.phase).toBe('incoming');
    const p = h.e.accept();
    // ICE + offer can race the mic prompt; both are queued until the peer exists.
    await h.e.onSignal('call-in-1', { t: 'ice', c: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });
    await p;
    await h.e.onSignal('call-in-1', { t: 'sdp', d: { type: 'offer', sdp: 'offer-x' } }); await flush();
    expect(h.sent.map(s => s.ev)).toEqual(['accept']);
    expect(h.signals[0]).toEqual({ t: 'sdp', d: { type: 'answer', sdp: 'answer-1' } });
    expect(h.peer.ice).toHaveLength(1);
  });

  it('drains an early offer and ICE sequentially after native audio setup', async () => {
    const delayed = harness({ audioDelay: true });
    delayed.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    const accepting = delayed.e.accept();
    const acceptingAgain = delayed.e.accept();
    await flush();
    await delayed.e.onSignal('call-in-1', { t: 'ice', c: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 } });
    await delayed.e.onSignal('call-in-1', { t: 'sdp', d: { type: 'offer', sdp: 'offer-early' } });
    // Later signal delivery must go through the audio barrier; no direct early handling.
    delayed.releaseAudio();
    await Promise.all([accepting, acceptingAgain]); await flush();
    expect(delayed.peer.answers).toBe(1);
    expect(delayed.peer.local.map(x => x.type)).toEqual(['answer']);
    expect(delayed.peer.ice).toEqual([{ candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 }]);
    expect(delayed.e.s.accepting).toBe(false);
    delayed.e.onAnsweredElsewhere({ callId: 'call-in-1' });
  });

  it('re-entrant accept actions share one native setup and one accept signal', async () => {
    const delayed = harness({ audioDelay: true });
    delayed.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    const accepting = delayed.e.accept();
    await flush();
    // A separate delayed invocation cannot pass the guard while native setup is underway.
    const acceptingAgain = delayed.e.accept();
    delayed.releaseAudio();
    await Promise.all([accepting, acceptingAgain]);
    await delayed.e.accept();
    expect(delayed.sent.filter(s => s.ev === 'accept')).toHaveLength(1);
    expect(delayed.audio.filter(a => a.active)).toHaveLength(1);
    delayed.e.onAnsweredElsewhere({ callId: 'call-in-1' });
  });

  it('a second incoming call while busy is auto-declined with reason busy and does not disturb the first', async () => {
    h.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    expect(h.e.onIncoming({ callId: 'call-in-2', from: 'u_c', callerName: 'Cy' })).toBe('busy');
    expect(h.sent).toContainEqual({ ev: 'decline', callId: 'call-in-2', arg: 'busy' });
    expect(h.e.s.callId).toBe('call-in-1');
  });

  it('incoming ring fallback times out locally', () => {
    h.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    h.clock.advance(50_000);
    expect(h.e.s).toMatchObject({ phase: 'ended', status: 'No answer' });
  });

  it('microphone denial ends the call with a specific reason', async () => {
    const d = harness({ micDenied: true });
    d.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    await d.e.accept();
    expect(d.e.s).toMatchObject({ phase: 'ended', status: 'Microphone access is off' });
    expect(d.sent.find(s => s.ev === 'end')).toMatchObject({ arg: 'failed' });
  });

  it('ignores malformed, wrong-call and wrong-direction signals', async () => {
    await h.e.start('u_b', 'Bea'); await h.e.onAccepted({ callId: 'call-0001' }); await flush();
    await h.e.onSignal('call-0001', { t: 'sdp', d: { type: 'offer', sdp: 'evil' } }); // caller never takes offers
    await h.e.onSignal('other-call', { t: 'sdp', d: { type: 'answer', sdp: 'x' } });
    await h.e.onSignal('call-0001', { t: 'bogus' });
    expect(h.peer.remoteDescription).toBeNull();
    expect(parseSignal({ t: 'ice', c: { candidate: 5 } })).toBeNull();
    expect(parseSignal({ t: 'sdp', d: { type: 'pranswer', sdp: '' } })).toBeNull();
  });
});

describe('call engine — media controls & reconnection', () => {
  async function activeCaller() {
    const h = harness();
    await h.e.start('u_b', 'Bea'); await h.e.onAccepted({ callId: 'call-0001' }); await flush();
    await h.e.onSignal('call-0001', { t: 'sdp', d: { type: 'answer', sdp: 'a' } });
    h.peer.setConn('connected');
    return h;
  }

  it('mute disables the real audio track; speaker reconfigures the audio session with the full mode', async () => {
    const h = await activeCaller();
    h.e.toggleMute(); expect(h.track.enabled).toBe(false); expect(h.e.s.muted).toBe(true);
    h.e.toggleMute(); expect(h.track.enabled).toBe(true);
    await h.e.toggleSpeaker();
    expect(h.audio.at(-1)).toEqual({ active: true, speaker: true });
  });

  it('mute chosen before media exists is applied when the mic opens', async () => {
    const h = harness();
    h.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    h.e.toggleMute();
    await h.e.accept();
    expect(h.track.enabled).toBe(false);
  });

  it('caller: disconnected → reconnecting → ICE-restart offer after grace → back to active keeping answeredAt', async () => {
    const h = await activeCaller();
    const answeredAt = h.e.s.answeredAt;
    h.clock.advance(5000);
    h.peer.setConn('disconnected');
    expect(h.e.s).toMatchObject({ phase: 'reconnecting', status: 'Reconnecting…' });
    h.clock.advance(3000); await flush();
    expect(h.peer.offers.at(-1)).toEqual({ iceRestart: true });
    expect(h.signals.at(-1)).toMatchObject({ t: 'sdp', d: { type: 'offer' } });
    h.peer.setConn('connected');
    expect(h.e.s).toMatchObject({ phase: 'active', answeredAt });
  });

  it('caller: recovers quickly without restart if ICE self-heals inside the grace window', async () => {
    const h = await activeCaller();
    const n = h.peer.offers.length;
    h.peer.setConn('disconnected'); h.clock.advance(1000); h.peer.setConn('connected'); h.clock.advance(5000); await flush();
    expect(h.peer.offers.length).toBe(n); expect(h.e.s.phase).toBe('active');
  });

  it('gives up with "Connection lost" when reconnecting exceeds the deadline', async () => {
    const h = await activeCaller();
    h.peer.setConn('failed'); await flush();
    expect(h.e.s.phase).toBe('reconnecting');
    h.clock.advance(20_000);
    expect(h.e.s).toMatchObject({ phase: 'ended', status: 'Connection lost' });
    expect(h.peer.closed).toBe(true);
  });

  it('callee asks the caller to restart instead of offering (no glare); caller answers a restart request', async () => {
    const callee = harness();
    callee.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    await callee.e.accept();
    await callee.e.onSignal('call-in-1', { t: 'sdp', d: { type: 'offer', sdp: 'o' } }); await flush();
    callee.peer.setConn('connected');
    callee.peer.setConn('failed');
    expect(callee.signals.at(-1)).toEqual({ t: 'restart' });
    expect(callee.peer.offers).toHaveLength(0);

    const caller = await activeCaller();
    await caller.e.onSignal('call-0001', { t: 'restart' });
    expect(caller.peer.offers.at(-1)).toEqual({ iceRestart: true });
  });

  it('socket reconnect while media is down triggers an ICE restart', async () => {
    const h = await activeCaller();
    h.peer.connectionState = 'disconnected';
    h.e.onSocketReconnected(); await flush();
    expect(h.peer.offers.at(-1)).toEqual({ iceRestart: true });
  });

  it('audio-session teardown during accept cannot leak queued signaling into an ended call', async () => {
    const delayed = harness({ audioDelay: true });
    delayed.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    const accepting = delayed.e.accept();
    await flush();
    void delayed.e.onSignal('call-in-1', { t: 'sdp', d: { type: 'offer', sdp: 'offer-late' } });
    delayed.e.onEnded({ callId: 'call-in-1', reason: 'hangup' });
    delayed.releaseAudio();
    await accepting; await flush();
    expect(delayed.e.hasMedia).toBe(false);
    expect(delayed.signals).toHaveLength(0);
    expect(delayed.e.s.accepting).toBe(false);
  });

  it('hang-up, remote end and answered-elsewhere all release the mic and peer exactly once', async () => {
    const h = await activeCaller();
    h.e.hangup(); h.e.hangup();
    expect(h.sent.filter(s => s.ev === 'end')).toHaveLength(1);
    expect(h.track.stopped && h.peer.closed).toBe(true);
    expect(h.audio.filter(a => !a.active)).toHaveLength(1);

    const r = await activeCaller();
    r.e.onEnded({ callId: 'call-0001', reason: 'hangup' });
    expect(r.e.s.status).toBe('Call ended'); expect(r.peer.closed).toBe(true);
    expect(r.sent.filter(s => s.ev === 'end')).toHaveLength(0); // remote ended: don't echo

    const ae = harness();
    ae.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    ae.e.onAnsweredElsewhere({ callId: 'call-in-1' });
    expect(ae.e.s.phase).toBe('idle');
  });

  it('media opened after the call already ended is discarded', async () => {
    const h = harness();
    h.e.onIncoming({ callId: 'call-in-1', from: 'u_a', callerName: 'Al' });
    const p = h.e.accept();
    h.e.onEnded({ callId: 'call-in-1', reason: 'hangup' });
    await p;
    expect(h.peer.closed).toBe(true); expect(h.track.stopped).toBe(true);
    expect(h.e.hasMedia).toBe(false);
  });
});
