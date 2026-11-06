import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, FlatList, KeyboardAvoidingView, Platform, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import { C } from '../../../theme';
import { T, Tap, Avatar, Row, Button, Spinner, s, Screen} from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { Sheet } from '../../../components/Sheet';
import { Bubble } from '../../../components/Bubble';
import { useApp } from '../../../store/app';
import { loadMessages, loadOlder, markRead, send, sendTyping, refreshConversation, openDirect, dropConversation } from '../../../lib/engine';
import { api, errMsg } from '../../../lib/api';
import { convTitle, otherMember, preview } from '../../../lib/format';
import type { LocalMessage } from '../../../lib/db';
import { startCall, callsAvailable } from '../../../lib/calls';
import type { PublicUser } from '../../../lib/types';
import { removeMlsGroupMember } from '../../../lib/mls-session';

const MAX_FILE = 25 * 1024 * 1024;
const att0 = (mime: string, name: string, size: number) => ({ id: '', key: '', nonce: '', mime, name, size });

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useApp(st => st.me)!;
  const conv = useApp(st => st.conversations[id]);
  const msgs = useApp(st => st.messages[id]);
  const typingRaw = useApp(st => st.typing[id]);
  // Clock for expiring typing indicators: updated by a timer, never read during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!typingRaw?.length) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, [typingRaw]);
  const typing = (typingRaw ?? []).filter(t => t.until > now && t.userId !== me.id);
  const toast = useApp(st => st.showToast);
  const [text, setText] = useState(''); const [attachOpen, setAttachOpen] = useState(false); const [infoOpen, setInfoOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false); const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [replyingTo, setReplyingTo] = useState<LocalMessage | null>(null);
  const [peer, setPeer] = useState<(PublicUser & { isContact: boolean; blocked: boolean; verified: boolean }) | null>(null);
  const [older, setOlder] = useState<'idle' | 'loading' | 'done'>('idle');
  const lastTyping = useRef(0);
  const other = conv && conv.kind === 'direct' ? otherMember(conv, me.id) : undefined;

  useEffect(() => { loadMessages(id); if (!conv) refreshConversation(id).catch(() => toast('Could not open chat')); loadOlder(id).catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- run once per conversation id; conv/toast changes must not re-trigger loading
  useEffect(() => { markRead(id); }, [id, msgs?.length]);
  const loadPeer = () => other && api('GET', `/users/${other.id}`).then(setPeer).catch(() => {});
  useEffect(() => { loadPeer(); }, [other?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- refetch only when the peer changes, not on every render's new loadPeer

  const data = useMemo(() => [...(msgs ?? [])].reverse(), [msgs]);
  const nameOf = (uid: string) => conv?.members.find(m => m.id === uid)?.displayName || 'Former member';

  // voice
  const rec = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const rs = useAudioRecorderState(rec, 100);
  const levels = useRef<number[]>([]);
  useEffect(() => { if (rs.isRecording && rs.metering != null) levels.current.push(Math.min(1, Math.max(0.05, (rs.metering + 60) / 60))); }, [rs.durationMillis]); // eslint-disable-line react-hooks/exhaustive-deps -- sample one metering level per recorder tick (durationMillis), intentionally
  const startRec = async () => {
    const p = await requestRecordingPermissionsAsync();
    if (!p.granted) return toast('Allow microphone access in Settings to record');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    levels.current = []; await rec.prepareToRecordAsync(); rec.record();
  };
  const stopRec = async (cancel = false) => {
    const secs = rs.durationMillis / 1000; await rec.stop(); await setAudioModeAsync({ allowsRecording: false });
    const uri = rec.uri; if (cancel || !uri) return;
    if (secs < 0.7) return toast('Hold on — that was too short');
    const f = new File(uri); const size = f.size ?? 0;
    const n = levels.current; const wf = Array.from({ length: 28 }, (_, i) => n.length ? n[Math.floor((i / 28) * n.length)] : 0.4);
    send(id, { v: 1, type: 'voice', attachment: att0('audio/m4a', `voice-${Date.now()}.m4a`, size), durationSec: Math.round(secs), waveform: wf.map(x => Math.round(x * 100) / 100), sentAt: Date.now() }, { uri, mime: 'audio/m4a', name: 'voice.m4a', size });
  };

  const sendText = () => {
    const t = text.trim(); if (!t) return;
    const seen = new Set<string>();
    const mentions = [...t.matchAll(/@([a-zA-Z0-9._]+)/g)].flatMap(m => {
      const u = conv?.members.find(x => (x.username || '').toLowerCase() === m[1].toLowerCase());
      if (!u || seen.has(u.id)) return [];
      seen.add(u.id);
      return [{ userId: u.id, username: u.username || m[1] }];
    });
    send(id, { v: 1, type: 'text', text: t, sentAt: Date.now(), replyTo: replyingTo?.id || replyingTo?.clientId || undefined, mentions: mentions.length ? mentions : undefined });
    setText(''); setReplyingTo(null);
  };
  const pickContact = async () => {
    setAttachOpen(false);
    try {
      const r = await api<{ contacts: PublicUser[] }>('GET', '/contacts');
      setContacts(r.contacts); setContactOpen(true);
    } catch (e) { toast(errMsg(e)); }
  };
  const insertMention = (u: PublicUser) => {
    setText(t => t.replace(/(^|\s)@([a-zA-Z0-9._]*)$/, `$1@${u.username || ''} `));
  };
  const pickImage = async (camera: boolean) => {
    setAttachOpen(false);
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast(`Allow ${camera ? 'camera' : 'photo'} access in Settings`);
    const r = await (camera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync)({ mediaTypes: ['images'], quality: 0.7 });
    const a = r.assets?.[0]; if (r.canceled || !a) return;
    const size = a.fileSize ?? new File(a.uri).size ?? 0; if (size > MAX_FILE) return toast('Files must be under 25 MB');
    const mime = a.mimeType ?? 'image/jpeg', name = a.fileName ?? `photo-${Date.now()}.jpg`;
    send(id, { v: 1, type: 'image', attachment: att0(mime, name, size), width: a.width, height: a.height, caption: text.trim() || undefined, sentAt: Date.now() }, { uri: a.uri, mime, name, size });
    setText('');
  };
  const pickDoc = async () => {
    setAttachOpen(false);
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); const a = r.assets?.[0]; if (r.canceled || !a) return;
    const size = a.size ?? 0; if (size > MAX_FILE) return toast('Files must be under 25 MB');
    send(id, { v: 1, type: 'doc', attachment: att0(a.mimeType ?? 'application/octet-stream', a.name, size), sentAt: Date.now() }, { uri: a.uri, mime: a.mimeType ?? 'application/octet-stream', name: a.name, size });
  };

  if (!conv) return <Screen style={[s.screen, { alignItems: 'center', justifyContent: 'center' }]}><Spinner /></Screen>;
  const title = convTitle(conv, me.id);
  const stranger = conv.kind === 'direct' && peer && !peer.isContact;
  const sub = conv.kind === 'direct'
    ? (stranger ? <T size={12} style={{ color: C.red }}>Not in your contacts</T> : other ? <T mu size={12}><T size={12} style={{ color: other.onShift ? C.green : C.violet }}>●</T> {other.onShift ? 'On shift' : 'Off shift'} · {other.localTime}{other.role ? ` · ${other.role}` : ''}</T> : null)
    : <T mu size={12}>{conv.memberCount} members{typing.length ? ` · ${nameOf(typing[0].userId).split(' ')[0]} is typing…` : ''}</T>;
  const blockedMsg = peer?.blocked;

  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Row style={{ marginHorizontal: 12, marginTop: 4, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 22, backgroundColor: C.glass, borderWidth: 1, borderColor: C.border }}>
        <Tap testID="back" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} style={{ padding: 4 }}><Icon name="back" size={24} color={C.text} /></Tap>
        <Tap testID="chathead" onPress={() => (conv.kind === 'direct' ? router.push(`/safety/${conv.id}`) : conv.kind === 'workspace' && conv.workspaceId ? router.push(`/workspace/${conv.workspaceId}`) : setInfoOpen(true))} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar name={conv.kind === 'workspace' ? conv.workspace?.initial ?? title : title} uri={other?.avatar} size={38} bg={conv.kind === 'workspace' ? C.gold : undefined} />
          <View style={{ minWidth: 0, flex: 1 }}><T weight="700" size={16} numberOfLines={1}>{title}</T>{sub}</View>
        </Tap>
        {conv.kind === 'direct' ? <>
          <Tap testID="lock" accessibilityLabel="Safety number" onPress={() => router.push(`/safety/${conv.id}`)} style={{ padding: 4 }}><Icon name="shield" size={21} color={C.gold} /></Tap>
          <Tap testID="callbtn" accessibilityLabel="Call" onPress={() => { if (!other) return; if (!callsAvailable()) return toast('Calls need the Understage dev build (not Expo Go)'); startCall(other.id, title); }} style={{ padding: 4 }}><Icon name="phone" size={21} color={C.gold} /></Tap>
        </> : <Tap testID="groupinfo" accessibilityLabel="Members" onPress={() => setInfoOpen(true)} style={{ padding: 4 }}><Icon name="users" size={22} color={C.gold} /></Tap>}
      </Row>
      {stranger ? (
        <View testID="stranger" style={{ margin: 12, padding: 12, borderRadius: 14, backgroundColor: C.dangerCard, gap: 10 }}>
          <T size={13}>{title} isn’t in your contacts. Only reply if you know them from work. They can’t see your phone number.</T>
          <Row gap={8}>
            <Button testID="s-add" title="Add contact" style={{ flex: 1, paddingVertical: 10 }} onPress={async () => { try { await api('POST', '/contacts', { userId: other!.id }); loadPeer(); toast('Added to contacts'); } catch (e) { toast(errMsg(e)); } }} />
            <Button testID="s-block" title={blockedMsg ? 'Unblock' : 'Block'} variant="secondary" style={{ flex: 1, paddingVertical: 10 }} onPress={async () => { try { await api(blockedMsg ? 'DELETE' : 'POST', `/blocks/${other!.id}`); loadPeer(); toast(blockedMsg ? 'Unblocked' : 'Blocked — they can no longer message or call you'); } catch (e) { toast(errMsg(e)); } }} />
            <Button testID="s-report" title="Report" variant="danger" style={{ flex: 1, paddingVertical: 10 }} onPress={() => router.push({ pathname: '/report/[userId]', params: { userId: other!.id, conv: conv.id } })} />
          </Row>
        </View>) : null}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <FlatList inverted data={data} keyExtractor={m => m.clientId || m.key} contentContainerStyle={{ padding: 14, gap: 8 }}
          onEndReached={async () => { if (older !== 'idle') return; setOlder('loading'); const n = await loadOlder(id).catch(() => 0); setOlder(n < 50 ? 'done' : 'idle'); }}
          ListHeaderComponent={typing.length && conv.kind === 'direct' ? <View testID="typing" style={{ alignSelf: 'flex-start', backgroundColor: C.recv, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 }}><T mu>•••</T></View> : undefined}
          ListFooterComponent={<View style={{ alignSelf: 'center', backgroundColor: C.pill, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', gap: 6, alignItems: 'center', marginBottom: 6 }}><Icon name="lock" size={12} color={C.gold} /><T size={12} gold>Messages and calls are end-to-end encrypted</T></View>}
          renderItem={({ item }) => {
            const rt = item.body?.type === 'text' ? item.body.replyTo : undefined;
            const orig = rt ? (msgs ?? []).find(x => x.id === rt || x.clientId === rt) : undefined;
            return <Bubble m={item} mine={item.senderId === me.id} senderName={nameOf(item.senderId)} group={conv.kind !== 'direct'} replyPreview={orig ? preview(orig.body) : undefined} onReply={() => setReplyingTo(item)} readByNames={(item.readByUserIds ?? []).map(uid => nameOf(uid).split(' ')[0]).filter(Boolean)} />;
          }} />
        {conv.readonly ? (
          <Row style={{ justifyContent: 'center', padding: 14 }} testID="readonly"><Icon name="lock" size={14} color={C.muted} /><T mu size={13}>{conv.workspace?.wrapped ? 'Wrapped · read-only archive' : 'Only admins can post here'}</T></Row>
        ) : conv.e2eeError === 'GROUP_TOO_LARGE_FOR_E2EE' ? (
          <Row testID="e2ee-limited" style={{ justifyContent: 'center', padding: 14 }}><Icon name="lock" size={14} color={C.muted} /><T mu size={13}>This company chat is too large for end-to-end encryption (50 member limit). Use announcements instead.</T></Row>
        ) : rs.isRecording ? (
          <Row style={{ marginHorizontal: 12, marginBottom: 8, padding: 10, gap: 12, borderRadius: 28, backgroundColor: C.glass, borderWidth: 1, borderColor: C.border2 }}>
            <Tap testID="rec-cancel" onPress={() => stopRec(true)} style={{ padding: 6 }}><Icon name="x" size={22} color={C.muted} /></Tap>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.red }} />
            <T style={{ flex: 1 }}>Recording · {Math.floor(rs.durationMillis / 60000)}:{String(Math.floor(rs.durationMillis / 1000) % 60).padStart(2, '0')}</T>
            <Tap testID="rec-send" accessibilityLabel="Send voice note" onPress={() => stopRec(false)} style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}><Icon name="send" size={20} color="#000" /></Tap>
          </Row>
        ) : (
          <View>
            {(() => {
              const mentionMatch = conv.kind !== 'direct' ? text.match(/(^|\s)@([a-zA-Z0-9._]*)$/) : null;
              const mentionQ = mentionMatch ? mentionMatch[2].toLowerCase() : null;
              const mentionHits = mentionQ == null ? [] : conv.members.filter(m => m.id !== me.id && !!m.username && ((m.username || '').toLowerCase().startsWith(mentionQ) || (m.displayName || '').toLowerCase().includes(mentionQ))).slice(0, 6);
              return mentionHits.length ? (
                <View style={{ borderTopWidth: 1, borderTopColor: C.border, paddingHorizontal: 12, paddingVertical: 6, gap: 2 }}>
                  {mentionHits.map(u => (
                    <Tap key={u.id} onPress={() => insertMention(u)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                      <Avatar name={u.displayName || u.username || '?'} uri={u.avatar} size={28} />
                      <View><T weight="600">{u.displayName}</T><T mu size={12}>@{u.username}</T></View>
                    </Tap>
                  ))}
                </View>
              ) : null;
            })()}
            {replyingTo ? (
              <Row style={{ paddingHorizontal: 14, paddingTop: 8, gap: 8 }}>
                <View style={{ width: 3, alignSelf: 'stretch', backgroundColor: C.gold, borderRadius: 2 }} />
                <View style={{ flex: 1 }}>
                  <T size={12} gold>Reply</T>
                  <T mu size={13} numberOfLines={1}>{preview(replyingTo.body)}</T>
                </View>
                <Tap onPress={() => setReplyingTo(null)} style={{ padding: 4 }}><Icon name="x" size={16} color={C.muted} /></Tap>
              </Row>
            ) : null}
            <Row style={{ marginHorizontal: 12, marginBottom: 8, padding: 6, gap: 8, borderRadius: 28, backgroundColor: C.glass, borderWidth: 1, borderColor: C.border2 }}>
              <Tap testID="attach" accessibilityLabel="Attach" onPress={() => setAttachOpen(true)} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.input, alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={20} color={C.gold} /></Tap>
              <View style={{ flex: 1, backgroundColor: C.input, borderRadius: 22, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 4 }}>
                <TextInput testID="msg" value={text} onChangeText={t => { setText(t); if (Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); sendTyping(id); } }}
                  placeholder={other?.displayName ? `Message ${other.displayName.split(' ')[0]}…` : 'Message'} placeholderTextColor={C.muted} multiline style={{ color: C.text, fontSize: 15, maxHeight: 110 }} />
              </View>
              <Tap testID="sendbtn" accessibilityLabel={text.trim() ? 'Send' : 'Record voice note'} onPress={text.trim() ? sendText : startRec}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', shadowColor: C.gold, shadowOpacity: 0.55, shadowRadius: 10, shadowOffset: { width: 0, height: 2 } }}>
                <Icon name={text.trim() ? 'send' : 'mic'} size={21} color="#000" />
              </Tap>
            </Row>
          </View>
        )}
      </KeyboardAvoidingView>
      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title="Share securely">
        {([['img', 'Photo library', () => pickImage(false), 'a-photo'], ['cam', 'Camera', () => pickImage(true), 'a-cam'], ['doc', 'Document', pickDoc, 'a-doc'], ['users', 'Contact', pickContact, 'a-contact']] as const).map(([ic, t, fn, tid]) => (
          <Tap key={t} testID={tid} onPress={fn} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 }}><Icon name={ic} size={22} color={C.gold} /><T size={16}>{t}</T></Tap>))}
        <T mu size={12}>Files are encrypted on this phone before upload (max 25 MB).</T>
      </Sheet>
      <Sheet visible={contactOpen} onClose={() => setContactOpen(false)} title="Share a contact">
        {contacts.length ? contacts.map(c => (
          <Tap key={c.id} onPress={() => { setContactOpen(false); send(id, { v: 1, type: 'contact', userId: c.id, displayName: c.displayName || c.username || 'Contact', username: c.username || '', sentAt: Date.now() }); }} style={{ paddingVertical: 8 }}>
            <Row gap={12}><Avatar name={c.displayName || c.username || '?'} uri={c.avatar} size={36} /><View><T weight="600">{c.displayName}</T><T mu size={12}>{c.username ? `@${c.username}` : ''}</T></View></Row>
          </Tap>
        )) : <T mu size={13}>No contacts to share yet.</T>}
      </Sheet>
      <GroupInfo visible={infoOpen} onClose={() => setInfoOpen(false)} convId={conv.id} />
    </Screen>
  );
}

function GroupInfo({ visible, onClose, convId }: { visible: boolean; onClose: () => void; convId: string }) {
  const me = useApp(st => st.me)!; const conv = useApp(st => st.conversations[convId]); const toast = useApp(st => st.showToast);
  const [title, setTitle] = useState(conv?.title ?? ''); const [adding, setAdding] = useState(false);
  if (!conv) return null;
  const admin = conv.myRole === 'admin' || conv.myRole === 'owner';
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); await refreshConversation(convId); if (ok) toast(ok); } catch (e) { toast(errMsg(e)); } };
  return (
    <Sheet visible={visible} onClose={onClose} title={conv.kind === 'group' ? 'Group info' : 'Members'}>
      {conv.kind === 'group' && admin ? (
        <Row><TextInput testID="gtitle" value={title} onChangeText={setTitle} style={{ flex: 1, color: C.text, backgroundColor: C.input, borderRadius: 12, padding: 10 }} />
          <Tap testID="gtitle-save" onPress={() => act(() => api('PATCH', `/conversations/${convId}`, { title: title.trim() }), 'Renamed')}><T gold weight="700">Save</T></Tap></Row>) : null}
      <T mu size={12}>{conv.memberCount} members · encrypted chats support up to 50</T>
      {conv.members.map(m => (
        <Row key={m.id} style={{ paddingVertical: 6 }}>
          <Avatar name={m.displayName || '?'} uri={m.avatar} size={34} />
          <View style={{ flex: 1 }}><T weight="600">{m.displayName}{m.id === me.id ? ' (you)' : ''}</T><T mu size={12}>{m.convRole === 'member' ? '' : m.convRole + ' · '}{m.onShift ? 'On shift' : 'Off shift'}</T></View>
          {m.id !== me.id ? <Tap testID={`dm-${m.id}`} onPress={async () => { onClose(); try { router.push(`/chat/${await openDirect(m.id)}`); } catch (e) { toast(errMsg(e)); } }} style={{ padding: 6 }}><Icon name="chat" size={18} color={C.gold} /></Tap> : null}
          {admin && conv.kind === 'group' && m.id !== me.id ? <>
            <Tap testID={`role-${m.id}`} onPress={() => act(() => api('PATCH', `/conversations/${convId}/members/${m.id}`, { role: m.convRole === 'admin' ? 'member' : 'admin' }))} style={{ padding: 6 }}><Icon name="star" size={18} color={m.convRole === 'admin' ? C.gold : C.muted} /></Tap>
            <Tap testID={`rm-${m.id}`} onPress={() => act(() => removeMlsGroupMember(convId, m.id, me.id), 'Removed')} style={{ padding: 6 }}><Icon name="x" size={18} color={C.red} /></Tap>
          </> : null}
        </Row>))}
      {conv.kind === 'group' && admin ? <Button testID="gadd" title="Add people" variant="secondary" onPress={() => { onClose(); router.push({ pathname: '/new-group', params: { addTo: convId } }); }} /> : null}
      {conv.kind === 'group' ? <Button testID="gleave" title="Leave group" variant="danger" loading={adding} onPress={async () => { setAdding(true); try { await api('DELETE', `/conversations/${convId}/members/${me.id}`); dropConversation(convId); onClose(); router.replace('/'); } catch (e) { toast(errMsg(e)); } finally { setAdding(false); } }} /> : null}
    </Sheet>
  );
}
