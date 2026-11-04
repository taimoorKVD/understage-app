import React, { useEffect, useState } from 'react';
import { View, Image, Share, Modal, Pressable, ActivityIndicator } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { C } from '../theme';
import { T, Tap, Avatar, Row, Bar, avatarColor } from './ui';
import { Icon } from './Icon';
import { fetchAttachment, localUriFor, retry, discard } from '../lib/engine';
import type { LocalMessage } from '../lib/db';
import type { AttachmentRef } from '../../shared/e2ee';
import { clock, dur } from '../lib/time';
import { fmtSize } from '../lib/format';

function useAttachment(m: LocalMessage, att: AttachmentRef, auto: boolean) {
  const [uri, setUri] = useState<string | null>(() => localUriFor(m.clientId, att));
  const [err, setErr] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const load = async () => { if (!att.id) return null; setLoading(true); setErr(null); try { const u = await fetchAttachment(att); setUri(u); return u; } catch (e: any) { setErr(e?.message ?? 'Download failed'); return null; } finally { setLoading(false); } };
  useEffect(() => { if (!uri && auto && att.id) load(); }, [att.id]); // eslint-disable-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- auto-download once per attachment id; load() sets loading/uri state
  return { uri, err, loading, load };
}

function Tick({ m }: { m: LocalMessage }) {
  if (m.status === 'pending' || m.status === 'sending') return <Icon name="clock" size={11} color="#c9b8c0" />;
  if (m.status === 'failed') return <T size={11} style={{ color: '#ff8a9a' }}>!</T>;
  return <T size={11} style={{ color: m.status === 'read' ? '#7fc4ff' : '#e8d9c4' }}>{m.status === 'sent' ? '✓' : '✓✓'}</T>;
}

function Voice({ m, att, durationSec, waveform, mine }: { m: LocalMessage; att: AttachmentRef; durationSec: number; waveform: number[]; mine: boolean }) {
  const a = useAttachment(m, att, false);
  const player = useAudioPlayer(a.uri ? { uri: a.uri } : null);
  const st = useAudioPlayerStatus(player);
  const pct = st.duration ? st.currentTime / st.duration : 0;
  useEffect(() => { if (st.didJustFinish) { player.seekTo(0); player.pause(); } }, [st.didJustFinish, player]);
  const toggle = async () => {
    if (!a.uri) { const u = await a.load(); if (!u) return; player.replace({ uri: u }); player.play(); return; }
    if (st.playing) player.pause(); else player.play();
  };
  const bars = waveform.length ? waveform : Array.from({ length: 24 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 1.7)));
  return (
    <Row gap={10}>
      <Tap testID={`play-${m.clientId}`} accessibilityLabel={st.playing ? 'Pause' : 'Play voice note'} onPress={toggle} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}>
        {a.loading ? <ActivityIndicator size="small" color="#000" /> : <Icon name={st.playing ? 'pause' : 'play'} size={14} color="#000" />}
      </Tap>
      <Row gap={2} style={{ height: 24 }}>
        {bars.slice(0, 28).map((h, i) => <View key={i} style={{ width: 3, borderRadius: 2, height: Math.max(3, h * 24), backgroundColor: i / bars.length <= pct ? C.gold : mine ? '#e8d9c4' : '#a99' }} />)}
      </Row>
      <T size={12} style={{ opacity: 0.8 }}>{st.playing ? dur(st.currentTime) : dur(durationSec)}</T>
      {a.err ? <T size={11} style={{ color: '#ff8a9a' }}>{a.err}</T> : null}
    </Row>
  );
}

function ImageAtt({ m, att, caption, w, h }: { m: LocalMessage; att: AttachmentRef; caption?: string; w?: number; h?: number }) {
  const a = useAttachment(m, att, true); const [full, setFull] = useState(false);
  const ratio = w && h ? Math.min(1.6, Math.max(0.6, w / h)) : 1.4;
  return (
    <View>
      <Tap onPress={() => (a.uri ? setFull(true) : a.load())} style={{ width: 230, height: 230 / ratio, borderRadius: 12, overflow: 'hidden', backgroundColor: '#2a2030', alignItems: 'center', justifyContent: 'center' }}>
        {a.uri ? <Image source={{ uri: a.uri }} style={{ width: '100%', height: '100%' }} /> : a.loading ? <ActivityIndicator color={C.gold} /> : <Icon name="img" size={30} color={C.muted} />}
        {m.stage ? (
          <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,.5)', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <ActivityIndicator color={C.gold} /><T size={11}>{m.stage === 'encrypting' ? 'Encrypting on device…' : 'Uploading encrypted file…'}</T>
          </View>) : null}
      </Tap>
      {a.err ? <T size={11} style={{ color: '#ff8a9a' }}>{a.err} · tap to retry</T> : null}
      {caption ? <T size={15} style={{ marginTop: 6 }}>{caption}</T> : null}
      <Modal visible={full} transparent animationType="fade" onRequestClose={() => setFull(false)}>
        <Pressable onPress={() => setFull(false)} style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center' }}>
          {a.uri ? <Image source={{ uri: a.uri }} style={{ width: '100%', height: '80%' }} resizeMode="contain" /> : null}
          <Tap onPress={() => a.uri && Share.share({ url: a.uri })} style={{ position: 'absolute', bottom: 50, alignSelf: 'center' }}><T gold>Share</T></Tap>
        </Pressable>
      </Modal>
    </View>
  );
}

function DocAtt({ m, att }: { m: LocalMessage; att: AttachmentRef }) {
  const a = useAttachment(m, att, false);
  const open = async () => { const u = a.uri ?? (await a.load()); if (u) Share.share({ url: u, title: att.name }); };
  return (
    <Tap testID={`doc-${m.clientId}`} onPress={open} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 40, height: 48, borderRadius: 8, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' }}>{a.loading ? <ActivityIndicator color="#fff" /> : <Icon name="doc" size={22} color="#fff" />}</View>
      <View style={{ flexShrink: 1 }}>
        <T weight="700" size={14} numberOfLines={2}>{att.name}</T>
        <T size={12} style={{ opacity: 0.75 }}>{(att.name.split('.').pop() || 'file').toUpperCase()} · {fmtSize(att.size)}</T>
        {m.stage ? <Bar pct={m.stage === 'encrypting' ? 25 : 70} style={{ marginTop: 6, width: 150 }} /> : null}
        {a.err ? <T size={11} style={{ color: '#ff8a9a' }}>{a.err}</T> : null}
      </View>
    </Tap>
  );
}

export function Bubble({ m, mine, senderName, group }: { m: LocalMessage; mine: boolean; senderName: string; group: boolean }) {
  const b = m.body;
  if (b?.type === 'system') return <View style={{ alignSelf: 'center', backgroundColor: C.pill, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 }}><T size={12} gold>{b.text}</T></View>;
  let inner: React.ReactNode;
  if (!b) inner = <Row gap={6}><Icon name="lock" size={13} color={C.muted} /><T mu size={14} style={{ fontStyle: 'italic' }}>Couldn’t decrypt — sent to an older key on this account</T></Row>;
  else if (b.type === 'text') inner = <T size={15.5} selectable style={{ lineHeight: 21 }}>{b.text}</T>;
  else if (b.type === 'voice') inner = <Voice m={m} att={b.attachment} durationSec={b.durationSec} waveform={b.waveform} mine={mine} />;
  else if (b.type === 'image') inner = <ImageAtt m={m} att={b.attachment} caption={b.caption} w={b.width} h={b.height} />;
  else if (b.type === 'doc') inner = <DocAtt m={m} att={b.attachment} />;
  else inner = <Row gap={10}><Avatar name={b.displayName} size={34} /><View><T weight="700">{b.displayName}</T><T mu size={12}>@{b.username}</T></View></Row>;
  const readLabel = mine && group && m.status === 'read' && m.recipients > 1 ? ` · Read by ${m.readBy}/${m.recipients}` : '';
  const bubble = (
    <View testID={`msg-${m.clientId}`} style={{ maxWidth: '80%', alignSelf: mine ? 'flex-end' : 'flex-start', backgroundColor: mine ? C.sent : C.recv, borderRadius: 18, borderBottomRightRadius: mine ? 6 : 18, borderBottomLeftRadius: mine ? 18 : 6, paddingHorizontal: 12, paddingVertical: 8 }}>
      {group && !mine ? <T size={12} weight="700" style={{ color: avatarColor(senderName) }}>{senderName}</T> : null}
      {inner}
      <Row gap={4} style={{ alignSelf: 'flex-end', marginTop: 2 }}><T size={10.5} style={{ opacity: 0.65 }}>{clock(m.createdAt)}{readLabel}</T>{mine ? <Tick m={m} /> : null}</Row>
    </View>
  );
  const failed = mine && m.status === 'failed';
  return (
    <View style={{ gap: 4 }}>
      {group && !mine ? <Row gap={8} style={{ alignItems: 'flex-end' }}><Avatar name={senderName} size={28} />{bubble}</Row> : bubble}
      {failed ? (
        <Row gap={14} style={{ alignSelf: 'flex-end' }}>
          <T size={12} style={{ color: '#ff8a9a', flexShrink: 1 }}>Not sent{m.error ? ` · ${m.error}` : ''}</T>
          <Tap testID={`retry-${m.clientId}`} onPress={() => retry(m.clientId)}><T size={12} gold weight="700">Retry</T></Tap>
          <Tap testID={`discard-${m.clientId}`} onPress={() => discard(m.clientId)}><T size={12} mu weight="700">Delete</T></Tap>
        </Row>) : null}
    </View>
  );
}
