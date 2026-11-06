import { NativeModules } from 'react-native';
import { create } from 'zustand';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { setAudioModeAsync } from 'expo-audio';
import { api } from './api';
import { bus } from './events';
import { getSocket, myId } from './engine';
import { randomId } from './crypto';
import { useApp } from '../store/app';
import { CallEngine, IDLE_CALL, type CallSnapshot, type InviteResult, type SignalMsg } from '../../shared/call-engine';

/**
 * 1:1 audio calls over WebRTC (react-native-webrtc). Media is DTLS-SRTP peer-to-peer (or via TURN, which can't decrypt).
 * Signalling (SDP + ICE) is sealed with nacl.box between the two identity keys, so the server can't swap the DTLS
 * fingerprint — that's what makes the media end-to-end rather than just transport-encrypted.
 * The state machine, timeouts, ICE-restart and teardown logic live in shared/call-engine.ts (unit-tested);
 * this file only adapts it to Socket.IO, nacl.box, react-native-webrtc and the iOS audio session (expo-audio).
 * react-native-webrtc is native: it only exists in a dev build (`npx expo run:ios`), never in Expo Go.
 */
export type { CallPhase } from '../../shared/call-engine';
export const useCall = create<CallSnapshot>(() => ({ ...IDLE_CALL }));

let rtc: any = null;
function webrtc() {
  if (rtc) return rtc;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native module; absent in Expo Go
  try { if (!NativeModules.WebRTCModule) return null; rtc = require('react-native-webrtc'); return rtc; } catch { return null; }
}
export const callsAvailable = () => !!webrtc();

/** Peer identity keys by callId, used to seal/open that call's signalling. */
const peerKeys = new Map<string, string>();

function seal(callId: string, data: unknown) {
  const sk = useApp.getState().identity?.secretKey; const pub = peerKeys.get(callId);
  if (!sk || !pub) return null;
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(naclUtil.decodeUTF8(JSON.stringify(data)), nonce, naclUtil.decodeBase64(pub), naclUtil.decodeBase64(sk));
  return { n: naclUtil.encodeBase64(nonce), c: naclUtil.encodeBase64(box) };
}
function open(callId: string, env: { n: string; c: string }) {
  const sk = useApp.getState().identity?.secretKey; const pub = peerKeys.get(callId);
  if (!sk || !pub || typeof env?.n !== 'string' || typeof env?.c !== 'string') return null;
  try {
    const m = nacl.box.open(naclUtil.decodeBase64(env.c), naclUtil.decodeBase64(env.n), naclUtil.decodeBase64(pub), naclUtil.decodeBase64(sk));
    return m ? JSON.parse(naclUtil.encodeUTF8(m)) : null;
  } catch { return null; }
}

async function peerKey(id: string) { const u = await api('GET', `/users/${id}`); return (u.identityKey as string | null) ?? null; }

const callAudio = (active: boolean, speaker: boolean) => setAudioModeAsync(active
  // Always send the full mode: expo-audio resets omitted fields to defaults (a partial call would drop the mic).
  ? { allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: true, shouldRouteThroughEarpiece: !speaker }
  : { allowsRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers', shouldPlayInBackground: false, shouldRouteThroughEarpiece: false });

const engine = new CallEngine({
  invite: (callId, to) => new Promise<InviteResult>(resolve => {
    const s = getSocket();
    if (!s?.connected) return resolve({ ok: false, reason: 'offline' });
    s.timeout(10_000).emit('call:invite', { callId, to }, (err: unknown, r: InviteResult) => resolve(err ? { ok: false, reason: 'offline' } : (r ?? { ok: false })));
  }),
  accept: callId => { getSocket()?.emit('call:accept', { callId }); },
  decline: (callId, reason) => { getSocket()?.emit('call:decline', { callId, reason }); },
  end: (callId, reason) => { getSocket()?.emit('call:end', { callId, reason }); peerKeys.delete(callId); },
  signal: (callId, msg: SignalMsg) => { const data = seal(callId, msg); if (data) getSocket()?.emit('call:signal', { callId, data }); },
  createMedia: async () => {
    const W = webrtc(); if (!W) throw new Error('NO_WEBRTC');
    const ice = await api<{ iceServers: any[] }>('GET', '/calls/ice');
    const pc = new W.RTCPeerConnection({ iceServers: ice.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    try {
      const stream = await W.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));
      return { pc, stream };
    } catch (e) { try { pc.close(); } catch {} throw e; }
  },
  setAudio: ({ active, speaker }) => callAudio(active, speaker).catch(() => {}),
  newId: randomId,
  onChange: s => {
    const prev = useCall.getState();
    useCall.setState(s, true);
    if (prev.phase !== s.phase && (s.phase === 'ended' || s.phase === 'idle')) {
      if (prev.callId) peerKeys.delete(prev.callId);
      if (s.phase === 'ended') bus.emit('calls:changed');
    }
  },
  log: m => { if (__DEV__) console.log('[calls]', m); },
});

export async function startCall(peerId: string, peerName: string) {
  const { showToast } = useApp.getState();
  if (useCall.getState().phase !== 'idle' && useCall.getState().phase !== 'ended') return;
  if (!webrtc()) { showToast('Calls need the Understage dev build — Expo Go has no WebRTC'); return; }
  if (!getSocket()?.connected) { showToast('You are offline — calls need a connection'); return; }
  const pub = await peerKey(peerId).catch(() => null);
  if (!pub) { showToast(`${peerName} hasn't set up encryption yet`); return; }
  const callId = randomId();
  peerKeys.set(callId, pub);
  await engine.start(peerId, peerName, callId);
}
export async function accept() {
  if (!webrtc()) { useApp.getState().showToast('Calls need the Understage dev build'); return decline(); }
  await engine.accept();
}
export function decline() { engine.decline(); }
export function end(reason: 'hangup' | 'failed' = 'hangup') { engine.hangup(reason); }
export function toggleMute() { engine.toggleMute(); }
export function toggleSpeaker() { void engine.toggleSpeaker(); }

// ---- socket events (wired via the bus from engine.ts). Re-evaluation (Fast Refresh) drops the previous module's handlers.
const g = globalThis as any;
g.__understageCallsOff?.();
const offs = [
  bus.on('call:incoming', async (d: { callId: string; from: string; callerName: string }) => {
    if (!d?.callId || !d?.from) return;
    const cur = useCall.getState();
    if (cur.phase !== 'idle' && cur.phase !== 'ended') { engine.onIncoming(d); return; } // busy → auto-decline
    const pub = await peerKey(d.from).catch(() => null);
    if (!pub) { getSocket()?.emit('call:end', { callId: d.callId, reason: 'failed' }); return; }
    peerKeys.set(d.callId, pub);
    if (engine.onIncoming(d) === 'busy') peerKeys.delete(d.callId);
  }),
  bus.on('call:accepted', (d: { callId: string }) => { void engine.onAccepted(d); }),
  bus.on('call:signal', (d: { callId: string; from: string; data: any }) => {
    if (!d || d.from === myId() || d.callId !== useCall.getState().callId) return;
    const msg = open(d.callId, d.data); if (!msg) return; // forged/tampered signalling is ignored
    void engine.onSignal(d.callId, msg);
  }),
  bus.on('call:ended', (d: { callId: string; reason: string }) => { engine.onEnded(d); }),
  bus.on('call:answered-elsewhere', (d: { callId: string }) => { engine.onAnsweredElsewhere(d); }),
  bus.on('socket:connected', () => { engine.onSocketReconnected(); }),
];
g.__understageCallsOff = () => { offs.splice(0).forEach(f => f()); engine.hangup(); };
