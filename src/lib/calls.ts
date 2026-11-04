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

/**
 * 1:1 audio calls over WebRTC (react-native-webrtc). Media is DTLS-SRTP peer-to-peer (or via TURN, which can't decrypt).
 * Signalling (SDP + ICE) is sealed with nacl.box between the two identity keys, so the server can't swap the DTLS
 * fingerprint — that's what makes the media end-to-end rather than just transport-encrypted.
 * react-native-webrtc is native: it only exists in a dev build (`npx expo run:ios`), never in Expo Go.
 */
type Phase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';
interface CallState {
  phase: Phase; callId: string | null; peerId: string | null; peerName: string; direction: 'out' | 'in';
  answeredAt: number | null; muted: boolean; speaker: boolean; status: string;
}
export const useCall = create<CallState>(() => ({ phase: 'idle', callId: null, peerId: null, peerName: '', direction: 'out', answeredAt: null, muted: false, speaker: false, status: '' }));
const cs = () => useCall.getState();
const setC = (p: Partial<CallState>) => useCall.setState(p);

let rtc: any = null;
function webrtc() {
  if (rtc) return rtc;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native module; absent in Expo Go
  try { if (!NativeModules.WebRTCModule) return null; rtc = require('react-native-webrtc'); return rtc; } catch { return null; }
}
export const callsAvailable = () => !!webrtc();

let pc: any = null, local: any = null, peerPub: string | null = null;
const pendingIce: any[] = [];

function seal(data: unknown) {
  const sk = useApp.getState().identity!.secretKey;
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(naclUtil.decodeUTF8(JSON.stringify(data)), nonce, naclUtil.decodeBase64(peerPub!), naclUtil.decodeBase64(sk));
  return { n: naclUtil.encodeBase64(nonce), c: naclUtil.encodeBase64(box) };
}
function open(env: { n: string; c: string }) {
  const sk = useApp.getState().identity!.secretKey;
  const m = nacl.box.open(naclUtil.decodeBase64(env.c), naclUtil.decodeBase64(env.n), naclUtil.decodeBase64(peerPub!), naclUtil.decodeBase64(sk));
  return m ? JSON.parse(naclUtil.encodeUTF8(m)) : null;
}
const signal = (data: unknown) => getSocket()?.emit('call:signal', { callId: cs().callId, data: seal(data) });

async function peerKey(id: string) { const u = await api('GET', `/users/${id}`); return u.identityKey as string | null; }

async function makePc() {
  const W = webrtc();
  const ice = await api<{ iceServers: any[] }>('GET', '/calls/ice');
  pc = new W.RTCPeerConnection({ iceServers: ice.iceServers });
  local = await W.mediaDevices.getUserMedia({ audio: true, video: false });
  local.getTracks().forEach((t: any) => pc.addTrack(t, local));
  pc.addEventListener('icecandidate', (e: any) => { if (e.candidate) signal({ t: 'ice', c: e.candidate }); });
  pc.addEventListener('connectionstatechange', () => {
    const s = pc?.connectionState;
    if (s === 'connected' && cs().phase !== 'active') setC({ phase: 'active', answeredAt: Date.now(), status: '' });
    if (s === 'failed') end('failed');
  });
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: !cs().speaker }).catch(() => {});
}

export async function startCall(peerId: string, peerName: string) {
  const { showToast } = useApp.getState();
  if (cs().phase !== 'idle') return;
  if (!webrtc()) { showToast('Calls need the Understage dev build — Expo Go has no WebRTC'); return; }
  peerPub = await peerKey(peerId).catch(() => null);
  if (!peerPub) { showToast(`${peerName} hasn't set up encryption yet`); return; }
  const callId = randomId();
  setC({ phase: 'outgoing', callId, peerId, peerName, direction: 'out', answeredAt: null, muted: false, speaker: false, status: 'Calling…' });
  getSocket()?.emit('call:invite', { callId, to: peerId }, (r: any) => {
    if (r?.ok) setC({ status: r.calleeOnline ? 'Ringing…' : 'Calling…' });
    else finish(r?.reason === 'held' ? `${peerName} is off shift · call held` : 'Call failed');
  });
}
export async function accept() {
  if (cs().phase !== 'incoming') return;
  if (!webrtc()) { useApp.getState().showToast('Calls need the Understage dev build'); return decline(); }
  setC({ phase: 'connecting', status: 'Connecting…' });
  getSocket()?.emit('call:accept', { callId: cs().callId });
  try { await makePc(); } catch { end('failed'); }
}
export function decline() { getSocket()?.emit('call:decline', { callId: cs().callId }); finish('Declined'); }
export function end(reason: 'hangup' | 'failed' = 'hangup') { getSocket()?.emit('call:end', { callId: cs().callId, reason }); finish(reason === 'failed' ? 'Call failed' : 'Call ended'); }
export function toggleMute() { const muted = !cs().muted; local?.getAudioTracks().forEach((t: any) => (t.enabled = !muted)); setC({ muted }); }
export function toggleSpeaker() { const speaker = !cs().speaker; setC({ speaker }); setAudioModeAsync({ shouldRouteThroughEarpiece: !speaker }).catch(() => {}); }

function cleanup() { try { local?.getTracks().forEach((t: any) => t.stop()); pc?.close(); } catch {} pc = null; local = null; pendingIce.length = 0; }
function finish(status: string) {
  if (cs().phase === 'idle' || cs().phase === 'ended') return;
  cleanup(); setC({ phase: 'ended', status });
  setTimeout(() => { if (cs().phase === 'ended') setC({ phase: 'idle', callId: null, peerId: null, status: '' }); }, 1800);
  bus.emit('calls:changed');
}

// ---- socket events (wired via the bus from engine.ts)
bus.on('call:incoming', async (d: { callId: string; from: string; callerName: string }) => {
  if (cs().phase !== 'idle') { getSocket()?.emit('call:decline', { callId: d.callId }); return; }
  peerPub = await peerKey(d.from).catch(() => null);
  if (!peerPub) return;
  setC({ phase: 'incoming', callId: d.callId, peerId: d.from, peerName: d.callerName, direction: 'in', answeredAt: null, muted: false, speaker: false, status: 'Understage audio call…' });
});
bus.on('call:accepted', async (d: { callId: string }) => {
  if (d.callId !== cs().callId) return;
  setC({ phase: 'connecting', status: 'Connecting…' });
  try { await makePc(); const offer = await pc.createOffer({}); await pc.setLocalDescription(offer); signal({ t: 'sdp', d: { type: offer.type, sdp: offer.sdp } }); } catch { end('failed'); }
});
bus.on('call:signal', async (d: { callId: string; from: string; data: any }) => {
  if (d.callId !== cs().callId || d.from === myId()) return;
  const msg = open(d.data); if (!msg) return; // forged/tampered signalling is ignored
  const W = webrtc(); if (!W) return;
  for (let i = 0; i < 40 && !pc; i++) await new Promise(r => setTimeout(r, 100));
  if (!pc) return;
  if (msg.t === 'sdp') {
    await pc.setRemoteDescription(new W.RTCSessionDescription(msg.d));
    if (msg.d.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); signal({ t: 'sdp', d: { type: a.type, sdp: a.sdp } }); }
    for (const c of pendingIce.splice(0)) await pc.addIceCandidate(new W.RTCIceCandidate(c)).catch(() => {});
  } else if (msg.t === 'ice') {
    if (pc.remoteDescription) await pc.addIceCandidate(new W.RTCIceCandidate(msg.c)).catch(() => {}); else pendingIce.push(msg.c);
  }
});
bus.on('call:ended', (d: { callId: string; reason: string }) => {
  if (d.callId !== cs().callId) return;
  finish({ declined: 'Declined', 'no-answer': 'No answer', held: `${cs().peerName} is off shift · call held`, failed: 'Call failed' }[d.reason] || 'Call ended');
});
bus.on('call:answered-elsewhere', (d: { callId: string }) => { if (d.callId === cs().callId) { cleanup(); setC({ phase: 'idle', callId: null }); } });
